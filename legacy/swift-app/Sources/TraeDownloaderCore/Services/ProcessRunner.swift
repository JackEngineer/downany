import Foundation

public enum ProcessStreamKind: Sendable, Equatable {
    case stdout
    case stderr
}

public struct ProcessResult: Sendable {
    public var exitCode: Int32
    public var stdout: String
    public var stderr: String

    public init(exitCode: Int32, stdout: String, stderr: String) {
        self.exitCode = exitCode
        self.stdout = stdout
        self.stderr = stderr
    }
}

public final class ProcessExecution: @unchecked Sendable {
    public typealias LineHandler = @Sendable (ProcessStreamKind, String) -> Void

    private final class LineAccumulator {
        private var buffer = ""
        private let lock = NSLock()

        func append(data: Data) -> [String] {
            guard !data.isEmpty else {
                return []
            }

            let chunk = String(decoding: data, as: UTF8.self)
            guard !chunk.isEmpty else {
                return []
            }

            lock.lock()
            defer { lock.unlock() }

            buffer += chunk
            var lines: [String] = []
            while let newlineRange = buffer.range(of: "\n") {
                let line = String(buffer[..<newlineRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
                buffer.removeSubrange(..<newlineRange.upperBound)
                if !line.isEmpty {
                    lines.append(line)
                }
            }
            return lines
        }

        func flush() -> [String] {
            lock.lock()
            defer { lock.unlock() }

            let line = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
            buffer = ""
            return line.isEmpty ? [] : [line]
        }
    }

    private let process: Process
    private let stdoutPipe = Pipe()
    private let stderrPipe = Pipe()
    private let stdoutAccumulator = LineAccumulator()
    private let stderrAccumulator = LineAccumulator()
    private let lock = NSLock()
    private let terminationSemaphore = DispatchSemaphore(value: 0)
    private var stdoutData = Data()
    private var stderrData = Data()
    private var result: ProcessResult?
    private var started = false
    private var waitCalled = false

    public var onLine: LineHandler?

    public init(
        executableURL: URL,
        arguments: [String],
        environment: [String: String] = [:],
        currentDirectoryURL: URL? = nil
    ) {
        self.process = Process()
        self.process.executableURL = executableURL
        self.process.arguments = arguments
        self.process.environment = environment.isEmpty ? nil : environment
        self.process.currentDirectoryURL = currentDirectoryURL
        self.process.standardOutput = stdoutPipe
        self.process.standardError = stderrPipe
    }

    public func start() throws {
        guard !started else {
            return
        }

        started = true

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            self.handle(stream: .stdout, data: data)
        }

        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            self.handle(stream: .stderr, data: data)
        }

        process.terminationHandler = { [weak self] process in
            guard let self else { return }
            self.clearPipeHandlers()
            self.handleEOF(stream: .stdout)
            self.handleEOF(stream: .stderr)
            self.lock.lock()
            let stdout = String(decoding: self.stdoutData, as: UTF8.self)
            let stderr = String(decoding: self.stderrData, as: UTF8.self)
            self.result = ProcessResult(exitCode: process.terminationStatus, stdout: stdout, stderr: stderr)
            self.lock.unlock()
            self.terminationSemaphore.signal()
        }

        try process.run()
        // 尽量成为进程组组长，便于 cancel 时杀掉 ffmpeg 子进程
        let pid = process.processIdentifier
        if pid > 0 {
            _ = setpgid(pid, pid)
        }
    }

    public func waitUntilExit() -> ProcessResult {
        lock.lock()
        if waitCalled {
            let existing = result
            lock.unlock()
            return existing ?? ProcessResult(exitCode: -1, stdout: "", stderr: "waitUntilExit called twice")
        }
        waitCalled = true
        lock.unlock()

        terminationSemaphore.wait()
        lock.lock()
        defer { lock.unlock() }
        return result ?? ProcessResult(exitCode: -1, stdout: "", stderr: "process did not produce a result")
    }

    public func cancel() {
        guard process.isRunning else {
            return
        }
        let pid = process.processIdentifier
        if pid > 0 {
            // 负 PID：向整个进程组发 SIGTERM（覆盖 yt-dlp 拉起的 ffmpeg）
            kill(-pid, SIGTERM)
        }
        if process.isRunning {
            process.terminate()
        }
    }

    private func clearPipeHandlers() {
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        stderrPipe.fileHandleForReading.readabilityHandler = nil
    }

    private func handle(stream: ProcessStreamKind, data: Data) {
        if data.isEmpty {
            handleEOF(stream: stream)
            return
        }

        lock.lock()
        switch stream {
        case .stdout:
            stdoutData.append(data)
        case .stderr:
            stderrData.append(data)
        }
        lock.unlock()

        let lines = (stream == .stdout ? stdoutAccumulator : stderrAccumulator).append(data: data)
        for line in lines {
            onLine?(stream, line)
        }
    }

    private func handleEOF(stream: ProcessStreamKind) {
        let remainingLines = (stream == .stdout ? stdoutAccumulator : stderrAccumulator).flush()
        for line in remainingLines {
            onLine?(stream, line)
        }
    }
}

public final class ProcessRunner: @unchecked Sendable {
    public init() {}

    public func run(
        executableURL: URL,
        arguments: [String],
        environment: [String: String] = [:],
        currentDirectoryURL: URL? = nil,
        onLine: ProcessExecution.LineHandler? = nil
    ) throws -> ProcessResult {
        let execution = ProcessExecution(
            executableURL: executableURL,
            arguments: arguments,
            environment: environment,
            currentDirectoryURL: currentDirectoryURL
        )
        execution.onLine = onLine
        try execution.start()
        return execution.waitUntilExit()
    }

    public func makeExecution(
        executableURL: URL,
        arguments: [String],
        environment: [String: String] = [:],
        currentDirectoryURL: URL? = nil,
        onLine: ProcessExecution.LineHandler? = nil
    ) -> ProcessExecution {
        let execution = ProcessExecution(
            executableURL: executableURL,
            arguments: arguments,
            environment: environment,
            currentDirectoryURL: currentDirectoryURL
        )
        execution.onLine = onLine
        return execution
    }
}
