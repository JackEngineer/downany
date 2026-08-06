#!/usr/bin/env bash
# 拉取发布用 yt-dlp + ffmpeg 到 desktop/resources/bin
#
# TARGET_OS 控制目标平台，默认通过 `uname -s` 自动探测：
#   - darwin（默认）：沿用现有 macOS 静态二进制流程
#       yt-dlp_macos + scripts/install_ffmpeg.sh → 写入 ${DEST}/yt-dlp、${DEST}/ffmpeg
#   - windows（或 uname 输出 MINGW*/MSYS*/CYGWIN*/Windows_NT 时自动判定）：
#       下载官方 yt-dlp.exe + BtbN FFmpeg-Builds 静态 win64 zip（仅抽取 ffmpeg.exe）
#       → 写入 ${DEST}/yt-dlp.exe、${DEST}/ffmpeg.exe
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
#       固定源（BtbN/FFmpeg-Builds 静态构建，win64-gpl，选用已归档的日期化 tag 而非
#       浮动的 `latest`，以保证长期可复现）：
#         Release: https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-08-03-14-02
#         资产:    ffmpeg-n7.1.5-12-g1fdbca85aa-win64-gpl-7.1.zip（ffmpeg 7.1.5，与
#                  macOS 端 install_ffmpeg.sh 默认的 7.1.1 同一大版本线）
#         SHA256:  5559c3a40827c273d9eb1a783b67d43aaa364bc1e907d558fab6cd7dd24f2d63
#                  （核对自该 Release 附带的 checksums.sha256）
#       zip 内层结构为 <asset-basename>/bin/ffmpeg.exe（含 ffprobe.exe 等），本脚本
#       只从中抽取 ffmpeg.exe 落盘，保持产物精简。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${ROOT}/desktop/resources/bin"
mkdir -p "${DEST}"

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
  local url="${FFMPEG_WIN_URL:-https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-03-14-02/ffmpeg-n7.1.5-12-g1fdbca85aa-win64-gpl-7.1.zip}"
  local sha="${FFMPEG_WIN_SHA256:-}"
  echo "==> 下载 ffmpeg (Windows, BtbN static win64-gpl)"
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
  # BtbN zip 内层结构为 <asset-basename>/bin/ffmpeg.exe，逐层解出后只保留 ffmpeg.exe
  unzip -o -q "${tmp_zip}" -d "${tmp_dir}"
  local extracted
  extracted="$(find "${tmp_dir}" -type f -iname 'ffmpeg.exe' | head -n 1)"
  if [[ -z "${extracted}" ]]; then
    echo "未在压缩包中找到 ffmpeg.exe" >&2
    rm -rf "${tmp_dir}" "${tmp_zip}"
    exit 1
  fi
  cp "${extracted}" "${DEST}/ffmpeg.exe"
  rm -rf "${tmp_dir}" "${tmp_zip}"
}

case "${TARGET_OS}" in
  darwin)
    fetch_yt_dlp_darwin
    echo "==> 安装 ffmpeg (macOS)"
    FFMPEG_SHA256="${FFMPEG_SHA256:-}" "${ROOT}/scripts/install_ffmpeg.sh" "${DEST}"
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
