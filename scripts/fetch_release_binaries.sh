#!/usr/bin/env bash
# 拉取发布用 yt-dlp + ffmpeg/ffprobe 到 desktop/resources/bin
#
# TARGET_OS 控制目标平台，默认通过 `uname -s` 自动探测：
#   - darwin（默认）：从锁定源码构建 macOS arm64 静态 FFmpeg
#       yt-dlp_macos + scripts/install_ffmpeg.sh → 写入 ${DEST}/yt-dlp、
#       ${DEST}/ffmpeg、${DEST}/ffprobe
#   - windows（或 uname 输出 MINGW*/MSYS*/CYGWIN*/Windows_NT 时自动判定）：
#       下载官方 yt-dlp.exe + BtbN FFmpeg-Builds 静态 win64 zip（成对抽取工具）
#       → 写入 ${DEST}/yt-dlp.exe、${DEST}/ffmpeg.exe、${DEST}/ffprobe.exe
#     可在 macOS/Linux 上交叉拉取（用于本机验证或 CI 打包前置），也可在真实 Windows
#     的 Git Bash 下直接跑；纯 PowerShell 环境请改用同目录下的
#     scripts/fetch_release_binaries.ps1（版本锁定与本脚本保持同步）。
#
# 用法：
#   ./scripts/fetch_release_binaries.sh                    # 自动探测（本机 macOS → darwin 分支）
#   TARGET_OS=windows ./scripts/fetch_release_binaries.sh   # 强制拉取 Windows 二进制
#
# Windows 资源版本锁定（可通过下列环境变量覆盖）：
#   - YTDLP_VERSION / YTDLP_URL / YTDLP_SHA256
#       默认 URL: https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp.exe
#   - FFMPEG_WIN_URL / FFMPEG_WIN_SHA256
#       默认读取 packaging/ffmpeg-windows/source.lock.json。锁定 BtbN 每月最后一次构建
#       （上游保留两年），而不是只保留 14 份的普通日构建或浮动的 `latest`。
#       FFmpeg 7.1.5 与 macOS 端锁定的 7.1.1 保持同一大版本线；URL 与 SHA-256
#       在打包前由 scripts/windows_media_lock.mjs 对 GitHub Release 元数据再次核验。
#       zip 内层结构为 <asset-basename>/bin/ffmpeg.exe + ffprobe.exe；本脚本要求
#       两者恰好各一份且来自同一 bin 目录，再将这对工具一并落盘。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${ROOT}/desktop/resources/bin"
WINDOWS_MEDIA_LOCK="${ROOT}/packaging/ffmpeg-windows/source.lock.json"
mkdir -p "${DEST}"

read_windows_media_lock() {
  local key="$1"
  node -e '
    const fs = require("node:fs");
    const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = lock[process.argv[2]];
    if (typeof value !== "string" || !value.trim()) process.exit(2);
    process.stdout.write(value.trim());
  ' "${WINDOWS_MEDIA_LOCK}" "${key}"
}

detect_target_os() {
  local uname_s
  uname_s="$(uname -s 2>/dev/null || echo unknown)"
  case "${uname_s}" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT) echo "windows" ;;
    Darwin) echo "darwin" ;;
    *) echo "${uname_s}" ;;
  esac
}

RAW_TARGET_OS="${TARGET_OS:-$(detect_target_os)}"
case "${RAW_TARGET_OS}" in
  [Ww][Ii][Nn][Dd][Oo][Ww][Ss]|MINGW*|MSYS*|CYGWIN*|Windows_NT) TARGET_OS="windows" ;;
  [Dd]arwin) TARGET_OS="darwin" ;;
  *) TARGET_OS="${RAW_TARGET_OS}" ;;
esac

YTDLP_VERSION="${YTDLP_VERSION:-2026.02.04}"

fetch_yt_dlp_darwin() {
  local url="${YTDLP_URL:-https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_macos}"
  local sha="${YTDLP_SHA256:-}"
  echo "==> 下载 yt-dlp ${YTDLP_VERSION} (macOS)"
  local tmp="${DEST}/yt-dlp.download"
  curl -fL --retry 3 --retry-delay 2 -o "${tmp}" "${url}"
  local actual
  actual="$(shasum -a 256 "${tmp}" | awk '{print $1}')"
  echo "yt-dlp SHA256: ${actual}"
  if [[ -n "${sha}" && "${actual}" != "${sha}" ]]; then
    echo "yt-dlp SHA256 校验失败" >&2
    rm -f "${tmp}"
    exit 1
  fi
  mv "${tmp}" "${DEST}/yt-dlp"
  chmod +x "${DEST}/yt-dlp"
  "${DEST}/yt-dlp" --version
}

fetch_yt_dlp_windows() {
  local url="${YTDLP_URL:-https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp.exe}"
  local sha="${YTDLP_SHA256:-}"
  echo "==> 下载 yt-dlp ${YTDLP_VERSION} (Windows)"
  local tmp="${DEST}/yt-dlp.exe.download"
  curl -fL --retry 3 --retry-delay 2 -o "${tmp}" "${url}"
  local actual
  actual="$(shasum -a 256 "${tmp}" | awk '{print $1}')"
  echo "yt-dlp.exe SHA256: ${actual}"
  if [[ -n "${sha}" && "${actual}" != "${sha}" ]]; then
    echo "yt-dlp.exe SHA256 校验失败" >&2
    rm -f "${tmp}"
    exit 1
  fi
  mv "${tmp}" "${DEST}/yt-dlp.exe"
  chmod +x "${DEST}/yt-dlp.exe"
}

fetch_ffmpeg_windows() {
  local url="${FFMPEG_WIN_URL:-$(read_windows_media_lock url)}"
  local sha="${FFMPEG_WIN_SHA256:-$(read_windows_media_lock sha256)}"
  echo "==> 下载 ffmpeg + ffprobe (Windows, BtbN static win64-gpl)"
  echo "    ${url}"
  local tmp_zip="${DEST}/ffmpeg-win.zip"
  curl -fL --retry 3 --retry-delay 2 -o "${tmp_zip}" "${url}"
  local actual
  actual="$(shasum -a 256 "${tmp_zip}" | awk '{print $1}')"
  echo "ffmpeg zip SHA256: ${actual}"
  if [[ -n "${sha}" && "${actual}" != "${sha}" ]]; then
    echo "ffmpeg zip SHA256 校验失败" >&2
    rm -f "${tmp_zip}"
    exit 1
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  if ! (
    set -e
    unzip -o -q "${tmp_zip}" -d "${tmp_dir}"
    ffmpeg_matches=()
    ffprobe_matches=()
    while IFS= read -r -d '' candidate; do
      ffmpeg_matches+=("${candidate}")
    done < <(find "${tmp_dir}" -type f -iname 'ffmpeg.exe' -print0)
    while IFS= read -r -d '' candidate; do
      ffprobe_matches+=("${candidate}")
    done < <(find "${tmp_dir}" -type f -iname 'ffprobe.exe' -print0)
    if [[ "${#ffmpeg_matches[@]}" -ne 1 ]]; then
      echo "压缩包中的 ffmpeg.exe 数量应为 1，实际为 ${#ffmpeg_matches[@]}" >&2
      exit 1
    fi
    if [[ "${#ffprobe_matches[@]}" -ne 1 ]]; then
      echo "压缩包中的 ffprobe.exe 数量应为 1，实际为 ${#ffprobe_matches[@]}" >&2
      exit 1
    fi
    ffmpeg_parent="$(cd "$(dirname "${ffmpeg_matches[0]}")" && pwd -P)"
    ffprobe_parent="$(cd "$(dirname "${ffprobe_matches[0]}")" && pwd -P)"
    if [[ "${ffmpeg_parent}" != "${ffprobe_parent}" ]]; then
      echo "ffmpeg.exe 与 ffprobe.exe 不在同一归档 bin 目录" >&2
      exit 1
    fi
    cp "${ffmpeg_matches[0]}" "${DEST}/ffmpeg.exe"
    cp "${ffprobe_matches[0]}" "${DEST}/ffprobe.exe"
    chmod +x "${DEST}/ffmpeg.exe" "${DEST}/ffprobe.exe"
    "${DEST}/ffmpeg.exe" -version
    "${DEST}/ffprobe.exe" -version
  ); then
    rm -rf "${tmp_dir}" "${tmp_zip}"
    return 1
  fi
  rm -rf "${tmp_dir}" "${tmp_zip}"
}

case "${TARGET_OS}" in
  darwin)
    fetch_yt_dlp_darwin
    echo "==> 安装 ffmpeg (macOS)"
    "${ROOT}/scripts/install_ffmpeg.sh" "${DEST}"
    ;;
  windows)
    fetch_yt_dlp_windows
    fetch_ffmpeg_windows
    ;;
  *)
    echo "不支持的 TARGET_OS: ${TARGET_OS}（仅支持 darwin / windows）" >&2
    exit 1
    ;;
esac

echo "==> 完成: ${DEST}"
ls -la "${DEST}"
