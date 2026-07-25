#!/usr/bin/env bash
# 拉取发布用 yt-dlp + ffmpeg 到 desktop/resources/bin
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${ROOT}/desktop/resources/bin"
mkdir -p "${DEST}"

YTDLP_VERSION="${YTDLP_VERSION:-2026.02.04}"
YTDLP_URL="${YTDLP_URL:-https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_macos}"
YTDLP_SHA256="${YTDLP_SHA256:-}"

echo "==> 下载 yt-dlp ${YTDLP_VERSION}"
TMP_YT="${DEST}/yt-dlp.download"
curl -fL --retry 3 --retry-delay 2 -o "${TMP_YT}" "${YTDLP_URL}"
ACTUAL="$(shasum -a 256 "${TMP_YT}" | awk '{print $1}')"
echo "yt-dlp SHA256: ${ACTUAL}"
if [[ -n "${YTDLP_SHA256}" && "${ACTUAL}" != "${YTDLP_SHA256}" ]]; then
  echo "yt-dlp SHA256 校验失败" >&2
  rm -f "${TMP_YT}"
  exit 1
fi
mv "${TMP_YT}" "${DEST}/yt-dlp"
chmod +x "${DEST}/yt-dlp"
"${DEST}/yt-dlp" --version

echo "==> 安装 ffmpeg"
FFMPEG_SHA256="${FFMPEG_SHA256:-}" "${ROOT}/scripts/install_ffmpeg.sh" "${DEST}"

echo "==> 完成: ${DEST}"
ls -la "${DEST}"
