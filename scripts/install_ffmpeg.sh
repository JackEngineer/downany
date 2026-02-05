#!/bin/bash
# scripts/install_ffmpeg.sh

# 功能：下载并安装 macOS 平台的 FFmpeg 静态二进制文件（无需 brew/sudo）
# 使用方法：./scripts/install_ffmpeg.sh [install_dir]
# 参数说明：
#   install_dir: (可选) 安装目录，默认为项目根目录下的 bin 文件夹

set -e

# 获取脚本所在目录的上一级目录（项目根目录）
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 设置安装目录
if [ -n "$1" ]; then
    INSTALL_DIR="$1"
else
    INSTALL_DIR="${PROJECT_ROOT}/bin"
fi

# FFmpeg 下载地址 (macOS 64-bit Static)
FFMPEG_URL="https://evermeet.cx/ffmpeg/getrelease/zip"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}开始安装 FFmpeg (macOS Static Binary)...${NC}"

# 1. 创建目录
if [ ! -d "$INSTALL_DIR" ]; then
    echo -e "创建安装目录: ${INSTALL_DIR}"
    mkdir -p "$INSTALL_DIR"
fi

# 2. 下载
echo -e "正在下载 FFmpeg (可能需要几分钟)..."
echo -e "下载地址: ${FFMPEG_URL}"
curl -L -o "${INSTALL_DIR}/ffmpeg.zip" "$FFMPEG_URL"

if [ $? -ne 0 ]; then
    echo -e "${RED}下载失败！请检查网络连接。${NC}"
    exit 1
fi

# 3. 解压
echo -e "正在解压..."
unzip -o -q "${INSTALL_DIR}/ffmpeg.zip" -d "${INSTALL_DIR}"

if [ $? -ne 0 ]; then
    echo -e "${RED}解压失败！${NC}"
    rm "${INSTALL_DIR}/ffmpeg.zip"
    exit 1
fi

# 4. 清理
echo -e "清理临时文件..."
rm "${INSTALL_DIR}/ffmpeg.zip"

# 5. 设置权限
chmod +x "${INSTALL_DIR}/ffmpeg"

# 6. 验证
echo -e "验证安装..."
if [ -f "${INSTALL_DIR}/ffmpeg" ]; then
    VERSION=$("${INSTALL_DIR}/ffmpeg" -version | head -n 1)
    echo -e "${GREEN}安装成功！${NC}"
    echo -e "版本信息: ${VERSION}"
    echo -e ""
    echo -e "${YELLOW}使用提示:${NC}"
    echo -e "1. 二进制文件位置: ${INSTALL_DIR}/ffmpeg"
    echo -e "2. 若要添加到 PATH (临时):"
    echo -e "   export PATH=\"${INSTALL_DIR}:\$PATH\""
    echo -e "3. 已建议更新 src/core/downloader.py 自动检测此路径。"
else
    echo -e "${RED}安装失败：未找到 ffmpeg 二进制文件。${NC}"
    exit 1
fi
