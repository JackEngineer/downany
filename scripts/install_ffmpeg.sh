#!/bin/bash
# scripts/install_ffmpeg.sh — 下载 macOS 静态 ffmpeg，并校验 SHA256（可选强制）

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -n "${1:-}" ]; then
    INSTALL_DIR="$1"
else
    INSTALL_DIR="${PROJECT_ROOT}/bin"
fi

# 固定版本（evermeet.cx 提供的静态构建）
FFMPEG_VERSION="${FFMPEG_VERSION:-7.1.1}"
FFMPEG_URL="${FFMPEG_URL:-https://evermeet.cx/ffmpeg/ffmpeg-${FFMPEG_VERSION}.zip}"
# 若设置 FFMPEG_SHA256，下载后必须匹配；未设置时写入 .sha256 文件供下次核对
EXPECTED_SHA256="${FFMPEG_SHA256:-}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}开始安装 FFmpeg ${FFMPEG_VERSION} (macOS Static)...${NC}"
mkdir -p "${INSTALL_DIR}"

TMP_ZIP="${INSTALL_DIR}/ffmpeg.zip"
echo -e "下载: ${FFMPEG_URL}"
curl -fL --retry 3 --retry-delay 2 -o "${TMP_ZIP}" "${FFMPEG_URL}"

ACTUAL_SHA256="$(shasum -a 256 "${TMP_ZIP}" | awk '{print $1}')"
echo -e "下载文件 SHA256: ${ACTUAL_SHA256}"

if [ -n "${EXPECTED_SHA256}" ]; then
    if [ "${ACTUAL_SHA256}" != "${EXPECTED_SHA256}" ]; then
        echo -e "${RED}SHA256 校验失败！${NC}"
        echo -e "期望: ${EXPECTED_SHA256}"
        echo -e "实际: ${ACTUAL_SHA256}"
        rm -f "${TMP_ZIP}"
        exit 1
    fi
    echo -e "${GREEN}SHA256 校验通过${NC}"
else
    echo -e "${YELLOW}未设置 FFMPEG_SHA256，跳过强制校验。建议设置该环境变量以锁定构建。${NC}"
    echo "${ACTUAL_SHA256}  ffmpeg-${FFMPEG_VERSION}.zip" > "${INSTALL_DIR}/ffmpeg.zip.sha256"
fi

echo -e "正在解压..."
unzip -o -q "${TMP_ZIP}" -d "${INSTALL_DIR}"
rm -f "${TMP_ZIP}"

chmod +x "${INSTALL_DIR}/ffmpeg"

if [ -x "${INSTALL_DIR}/ffmpeg" ]; then
    VERSION="$("${INSTALL_DIR}/ffmpeg" -version | head -n 1)"
    echo -e "${GREEN}安装成功！${NC}"
    echo -e "版本信息: ${VERSION}"
    echo -e "路径: ${INSTALL_DIR}/ffmpeg"
else
    echo -e "${RED}安装失败：未找到可执行的 ffmpeg。${NC}"
    exit 1
fi
