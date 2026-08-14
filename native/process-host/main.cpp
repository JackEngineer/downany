// DownanyProcessHost: small, dependency-free suspended process guardian.
// The Electron side owns identity/policy checks; this binary owns only the
// OS containment and fd3 control protocol.

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#include <tlhelp32.h>
#else
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <spawn.h>
#include <sys/select.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
#endif

namespace {

constexpr int kControlFd = 3;
constexpr int kPollMs = 100;

struct LaunchSpec {
  std::string instanceId;
  std::vector<std::string> target;
};

std::string trim(std::string value) {
  const auto first = value.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return {};
  const auto last = value.find_last_not_of(" \t\r\n");
  return value.substr(first, last - first + 1);
}

bool isSafeInstanceId(const std::string &value) {
  if (value.empty() || value.size() > 128) return false;
  for (const unsigned char ch : value) {
    if (!(ch == '-' || ch == '_' || ch == '.' ||
          (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') ||
          (ch >= 'A' && ch <= 'Z'))) {
      return false;
    }
  }
  return true;
}

bool isAbsoluteTarget(const std::string &value) {
#ifdef _WIN32
  if (value.size() >= 3 && ((value[0] >= 'A' && value[0] <= 'Z') ||
                            (value[0] >= 'a' && value[0] <= 'z')) &&
      value[1] == ':' && (value[2] == '\\' || value[2] == '/')) {
    return true;
  }
  return value.size() >= 3 && value[0] == '\\' && value[1] == '\\';
#else
  return !value.empty() && value[0] == '/';
#endif
}

bool parseArgs(int argc, char **argv, LaunchSpec &out) {
  if (argc < 4 || std::string(argv[1]) != "--instance-id" ||
      std::string(argv[3]) != "--") {
    return false;
  }
  out.instanceId = argv[2];
  if (!isSafeInstanceId(out.instanceId)) return false;
  for (int i = 4; i < argc; ++i) out.target.emplace_back(argv[i]);
  return !out.target.empty() && isAbsoluteTarget(out.target.front());
}

std::string jsonEscape(const std::string &value) {
  std::ostringstream out;
  for (const unsigned char ch : value) {
    switch (ch) {
      case '\\': out << "\\\\"; break;
      case '"': out << "\\\""; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (ch < 0x20) {
          out << "\\u00" << "0123456789abcdef"[(ch >> 4) & 0xf]
              << "0123456789abcdef"[ch & 0xf];
        } else {
          out << static_cast<char>(ch);
        }
    }
  }
  return out.str();
}

bool isResumeCommand(const std::string &line) {
  return trim(line) == R"({"command":"resume"})";
}

std::string utcNow() {
  using namespace std::chrono;
  const auto now = system_clock::now();
  const auto wholeSeconds = time_point_cast<std::chrono::seconds>(now);
  const auto millis = duration_cast<milliseconds>(now - wholeSeconds).count();
  const std::time_t raw = system_clock::to_time_t(wholeSeconds);
  std::tm tm{};
#ifdef _WIN32
  gmtime_s(&tm, &raw);
#else
  gmtime_r(&raw, &tm);
#endif
  char buffer[32]{};
  std::snprintf(buffer, sizeof(buffer), "%04d-%02d-%02dT%02d:%02d:%02d.%03lldZ",
                tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour,
                tm.tm_min, tm.tm_sec, static_cast<long long>(millis));
  return buffer;
}

#ifdef _WIN32

bool writeControl(const std::string &line) {
  const intptr_t raw = _get_osfhandle(kControlFd);
  if (raw == -1) return false;
  const HANDLE control = reinterpret_cast<HANDLE>(raw);
  std::string bytes = line + "\n";
  DWORD written = 0;
  return WriteFile(control, bytes.data(), static_cast<DWORD>(bytes.size()),
                   &written, nullptr) && written == bytes.size();
}

bool readControl(std::string &line, int timeoutMs) {
  const intptr_t raw = _get_osfhandle(kControlFd);
  if (raw == -1) return false;
  const HANDLE control = reinterpret_cast<HANDLE>(raw);
  const auto deadline = GetTickCount64() + static_cast<ULONGLONG>(timeoutMs);
  line.clear();
  while (GetTickCount64() <= deadline) {
    DWORD available = 0;
    if (!PeekNamedPipe(control, nullptr, 0, nullptr, &available, nullptr)) {
      return false;
    }
    if (available > 0) {
      char ch = 0;
      DWORD read = 0;
      if (!ReadFile(control, &ch, 1, &read, nullptr) || read == 0) return false;
      if (ch == '\n') return true;
      if (line.size() >= 4096) return false;
      line.push_back(ch);
    } else {
      Sleep(10);
    }
  }
  return false;
}

DWORD parentPid() {
  const DWORD current = GetCurrentProcessId();
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  DWORD result = 0;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (entry.th32ProcessID == current) {
        result = entry.th32ParentProcessID;
        break;
      }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return result;
}

std::wstring utf8ToWide(const std::string &value) {
  if (value.empty()) return {};
  const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                        value.data(), static_cast<int>(value.size()),
                                        nullptr, 0);
  if (count <= 0) return {};
  std::wstring result(static_cast<size_t>(count), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(), count) != count) {
    return {};
  }
  return result;
}

std::string wideToUtf8(const std::wstring &value) {
  if (value.empty()) return {};
  const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
                                        value.data(), static_cast<int>(value.size()),
                                        nullptr, 0, nullptr, nullptr);
  if (count <= 0) return {};
  std::string result(static_cast<size_t>(count), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(), count,
                          nullptr, nullptr) != count) {
    return {};
  }
  return result;
}

std::wstring quoteArg(const std::wstring &value) {
  std::wstring out = L"\"";
  size_t backslashes = 0;
  for (const wchar_t ch : value) {
    if (ch == L'\\') {
      ++backslashes;
    } else if (ch == L'"') {
      out.append(backslashes * 2 + 1, L'\\');
      out.push_back(L'"');
      backslashes = 0;
    } else {
      out.append(backslashes, L'\\');
      backslashes = 0;
      out.push_back(ch);
    }
  }
  out.append(backslashes * 2, L'\\');
  out.push_back(L'"');
  return out;
}

std::wstring commandLine(const std::vector<std::string> &args) {
  std::wstring out;
  for (const auto &arg : args) {
    const auto wide = utf8ToWide(arg);
    if (wide.empty() && !arg.empty()) return {};
    if (!out.empty()) out.push_back(L' ');
    out += quoteArg(wide);
  }
  return out;
}

bool terminateJob(HANDLE job) {
  if (!job) return true;
  return TerminateJobObject(job, 0) != 0;
}

bool jobEmpty(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
  return QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                   &info, sizeof(info), nullptr) != 0 &&
         info.ActiveProcesses == 0;
}

int runWindows(const LaunchSpec &spec) {
  const DWORD parent = parentPid();
  if (parent == 0) return 70;
  HANDLE parentHandle = OpenProcess(SYNCHRONIZE, FALSE, parent);
  if (!parentHandle) return 71;
  const intptr_t rawControl = _get_osfhandle(kControlFd);
  if (rawControl == -1) {
    CloseHandle(parentHandle);
    return 72;
  }
  const HANDLE control = reinterpret_cast<HANDLE>(rawControl);
  SetHandleInformation(control, HANDLE_FLAG_INHERIT, 0);

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) {
    CloseHandle(parentHandle);
    return 73;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits))) {
    CloseHandle(job); CloseHandle(parentHandle); return 74;
  }

  std::vector<std::wstring> wideArgs;
  wideArgs.reserve(spec.target.size());
  for (const auto &arg : spec.target) {
    auto value = utf8ToWide(arg);
    if (value.empty() && !arg.empty()) {
      CloseHandle(job); CloseHandle(parentHandle); return 75;
    }
    wideArgs.push_back(std::move(value));
  }
  std::vector<std::string> commandArgs = spec.target;
  const std::wstring executable = wideArgs.front();
  std::wstring command = commandLine(commandArgs);
  if (command.empty()) {
    CloseHandle(job); CloseHandle(parentHandle); return 76;
  }

  HANDLE stdHandles[3] = {GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE)};
  SIZE_T attributeSize = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
  std::vector<unsigned char> attributeBuffer(attributeSize);
  auto *attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeBuffer.data());
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attributeSize) ||
      !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                 stdHandles, sizeof(stdHandles), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributes); CloseHandle(job); CloseHandle(parentHandle); return 77;
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = stdHandles[0];
  startup.StartupInfo.hStdOutput = stdHandles[1];
  startup.StartupInfo.hStdError = stdHandles[2];
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION process{};
  std::vector<wchar_t> mutableCommand(command.begin(), command.end());
  mutableCommand.push_back(L'\0');
  const DWORD flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
                      EXTENDED_STARTUPINFO_PRESENT;
  const BOOL created = CreateProcessW(executable.c_str(), mutableCommand.data(),
                                      nullptr, nullptr, TRUE, flags, nullptr,
                                      nullptr, &startup.StartupInfo, &process);
  DeleteProcThreadAttributeList(attributes);
  if (!created) {
    CloseHandle(job); CloseHandle(parentHandle); return 78;
  }
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    TerminateProcess(process.hProcess, 1);
    WaitForSingleObject(process.hProcess, 5000);
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
    CloseHandle(job); CloseHandle(parentHandle); return 79;
  }

  std::ostringstream handshake;
  handshake << "{\"schemaVersion\":2,\"instanceId\":\"" << jsonEscape(spec.instanceId)
            << "\",\"guardianPid\":" << GetCurrentProcessId()
            << ",\"guardianStartedAt\":\"" << utcNow()
            << "\",\"targetPid\":" << process.dwProcessId
            << ",\"targetStartedAt\":\"" << utcNow()
            << "\",\"containment\":\"windows_job_object\",\"processGroupId\":null}";
  if (!writeControl(handshake.str())) {
    terminateJob(job);
    WaitForSingleObject(process.hProcess, 5000);
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
    CloseHandle(job); CloseHandle(parentHandle); return 80;
  }

  std::string commandLineFromParent;
  if (!readControl(commandLineFromParent, 30'000) || !isResumeCommand(commandLineFromParent)) {
    terminateJob(job);
    WaitForSingleObject(process.hProcess, 5000);
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
    CloseHandle(job); CloseHandle(parentHandle); return 81;
  }
  if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
    terminateJob(job);
    WaitForSingleObject(process.hProcess, 5000);
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
    CloseHandle(job); CloseHandle(parentHandle); return 82;
  }

  bool failed = false;
  for (;;) {
    if (WaitForSingleObject(parentHandle, 0) == WAIT_OBJECT_0) { failed = true; terminateJob(job); break; }
    DWORD available = 0;
    if (!PeekNamedPipe(control, nullptr, 0, nullptr, &available, nullptr)) {
      failed = true;
      terminateJob(job);
      break;
    }
    if (available > 0) {
      std::string lateCommand;
      failed = true;
      (void)readControl(lateCommand, 250);
      terminateJob(job);
      break;
    }
    if (WaitForSingleObject(process.hProcess, 0) == WAIT_OBJECT_0 && jobEmpty(job)) break;
    Sleep(kPollMs);
  }
  if (failed) {
    const auto deadline = GetTickCount64() + 5000;
    while (!jobEmpty(job) && GetTickCount64() < deadline) Sleep(kPollMs);
  }
  DWORD exitCode = 1;
  GetExitCodeProcess(process.hProcess, &exitCode);
  CloseHandle(process.hThread); CloseHandle(process.hProcess);
  CloseHandle(job); CloseHandle(parentHandle);
  return failed ? 83 : static_cast<int>(exitCode);
}

#else

bool writeControl(const std::string &line) {
  std::string bytes = line + "\n";
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t written = ::write(kControlFd, bytes.data() + offset, bytes.size() - offset);
    if (written <= 0) return false;
    offset += static_cast<size_t>(written);
  }
  return true;
}

bool parentAlive(pid_t parent) {
  if (parent <= 1) return false;
  if (kill(parent, 0) == 0) return true;
  return errno == EPERM;
}

bool readControlLine(std::string &line, int timeoutMs) {
  line.clear();
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  for (;;) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count();
    if (remaining <= 0) return false;
    fd_set set;
    FD_ZERO(&set); FD_SET(kControlFd, &set);
    timeval tv{};
    tv.tv_sec = static_cast<long>(remaining / 1000);
    tv.tv_usec = static_cast<long>((remaining % 1000) * 1000);
    const int ready = select(kControlFd + 1, &set, nullptr, nullptr, &tv);
    if (ready < 0) { if (errno == EINTR) continue; return false; }
    if (ready == 0) return false;
    char ch = 0;
    const ssize_t count = ::read(kControlFd, &ch, 1);
    if (count != 1) return false;
    if (ch == '\n') return true;
    if (line.size() >= 4096) return false;
    line.push_back(ch);
  }
}

bool processGroupEmpty(pid_t pgid) {
  if (pgid <= 1) return false;
  if (kill(-pgid, 0) == 0) return false;
  return errno == ESRCH;
}

void terminateGroup(pid_t pgid) {
  if (pgid <= 1) return;
  (void)kill(-pgid, SIGTERM);
  for (int i = 0; i < 20 && !processGroupEmpty(pgid); ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  if (!processGroupEmpty(pgid)) (void)kill(-pgid, SIGKILL);
  for (int i = 0; i < 50 && !processGroupEmpty(pgid); ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
}

int runDarwin(const LaunchSpec &spec) {
  if (!parentAlive(getppid())) return 70;
  (void)fcntl(kControlFd, F_SETFD, FD_CLOEXEC);
  posix_spawnattr_t attr;
  posix_spawn_file_actions_t actions;
  if (posix_spawnattr_init(&attr) != 0 || posix_spawn_file_actions_init(&actions) != 0) return 71;
  short flags = POSIX_SPAWN_START_SUSPENDED | POSIX_SPAWN_SETPGROUP;
  if (posix_spawnattr_setflags(&attr, flags) != 0 || posix_spawnattr_setpgroup(&attr, 0) != 0 ||
      posix_spawn_file_actions_addclose(&actions, kControlFd) != 0) {
    posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attr); return 72;
  }
  std::vector<std::vector<char>> storage;
  storage.reserve(spec.target.size());
  std::vector<char *> childArgv;
  for (const auto &arg : spec.target) {
    storage.emplace_back(arg.begin(), arg.end());
    storage.back().push_back('\0');
    childArgv.push_back(storage.back().data());
  }
  childArgv.push_back(nullptr);
  pid_t child = 0;
  const int spawnResult = posix_spawn(&child, childArgv[0], &actions, &attr,
                                     childArgv.data(), environ);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attr);
  if (spawnResult != 0 || child <= 1) return 73;
  const pid_t pgid = child;
  std::ostringstream handshake;
  handshake << "{\"schemaVersion\":2,\"instanceId\":\"" << jsonEscape(spec.instanceId)
            << "\",\"guardianPid\":" << getpid()
            << ",\"guardianStartedAt\":\"" << utcNow()
            << "\",\"targetPid\":" << child
            << ",\"targetStartedAt\":\"" << utcNow()
            << "\",\"containment\":\"darwin_process_group\",\"processGroupId\":" << pgid << "}";
  if (!writeControl(handshake.str())) { terminateGroup(pgid); return 74; }
  std::string command;
  if (!readControlLine(command, 30'000) || !isResumeCommand(command)) {
    terminateGroup(pgid); return 75;
  }
  if (kill(child, SIGCONT) != 0) { terminateGroup(pgid); return 76; }

  bool parentLost = false;
  int status = 1;
  bool reaped = false;
  for (;;) {
    if (!parentAlive(getppid())) { parentLost = true; terminateGroup(pgid); }
    fd_set controlSet;
    FD_ZERO(&controlSet);
    FD_SET(kControlFd, &controlSet);
    timeval controlTimeout{};
    controlTimeout.tv_sec = 0;
    controlTimeout.tv_usec = kPollMs * 1000;
    const int controlReady = select(kControlFd + 1, &controlSet, nullptr, nullptr, &controlTimeout);
    if (controlReady > 0 && FD_ISSET(kControlFd, &controlSet)) {
      char late = 0;
      const ssize_t count = ::read(kControlFd, &late, 1);
      parentLost = true;
      terminateGroup(pgid);
      if (count > 0) {
        // Any command after resume is intentionally invalid.  The byte is
        // consumed only to avoid leaving a blocked control pipe behind.
      }
    } else if (controlReady < 0 && errno != EINTR) {
      parentLost = true;
      terminateGroup(pgid);
    }
    if (!reaped) {
      const pid_t result = waitpid(child, &status, WNOHANG);
      if (result == child) reaped = true;
      else if (result < 0 && errno == ECHILD) reaped = true;
    }
    if (reaped && processGroupEmpty(pgid)) break;
    if (parentLost && reaped && processGroupEmpty(pgid)) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(kPollMs));
  }
  if (parentLost) return 83;
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}

#endif

} // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
  std::vector<std::string> utf8Args;
  std::vector<char *> args;
  utf8Args.reserve(static_cast<size_t>(argc));
  args.reserve(static_cast<size_t>(argc));
  for (int i = 0; i < argc; ++i) {
    utf8Args.push_back(wideToUtf8(argv[i]));
    if (utf8Args.back().empty() && argv[i][0] != L'\0') {
      std::fprintf(stderr, "invalid UTF-16 command line\n");
      return 64;
    }
  }
  for (auto &value : utf8Args) args.push_back(value.data());
  LaunchSpec spec;
  if (!parseArgs(argc, args.data(), spec)) {
    std::fprintf(stderr, "usage: DownanyProcessHost --instance-id <id> -- <absolute-target> [args...]\n");
    return 64;
  }
  return runWindows(spec);
}
#else
int main(int argc, char **argv) {
  LaunchSpec spec;
  if (!parseArgs(argc, argv, spec)) {
    std::fprintf(stderr, "usage: DownanyProcessHost --instance-id <id> -- <absolute-target> [args...]\n");
    return 64;
  }
  return runDarwin(spec);
}
#endif
