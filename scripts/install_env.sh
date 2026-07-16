#!/bin/bash
# 功能：初始化开发环境
# 使用方法：./scripts/install_env.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "项目根目录: $PROJECT_ROOT"
echo "正在检查 Python 环境..."
if ! command -v python3 &> /dev/null; then
    echo "错误：未找到 python3，请先安装 Python 3。"
    exit 1
fi

if [ ! -d "venv" ]; then
    echo "正在创建虚拟环境 venv..."
    python3 -m venv venv
else
    echo "虚拟环境 venv 已存在。"
fi

echo "正在激活虚拟环境并安装依赖..."
# shellcheck disable=SC1091
source venv/bin/activate
pip install --upgrade pip
if [ -f "requirements.txt" ]; then
    pip install -r requirements.txt
    if [ -f "requirements-dev.txt" ]; then
        pip install -r requirements-dev.txt
    fi
    echo "依赖安装完成。"
else
    echo "警告：未找到 requirements.txt 文件。"
fi

LOCAL_FFMPEG="./bin/ffmpeg"
if [ -x "$LOCAL_FFMPEG" ]; then
    echo "检测到本地 ffmpeg: $LOCAL_FFMPEG"
    export PATH="$PROJECT_ROOT/bin:$PATH"
elif command -v ffmpeg &> /dev/null; then
    echo "检测到系统 ffmpeg: $(which ffmpeg)"
else
    echo "警告：未检测到 ffmpeg。yt-dlp 合并视频流需要 ffmpeg。"
    echo "正在尝试自动安装 ffmpeg (static binary)..."
    chmod +x ./scripts/install_ffmpeg.sh
    if ./scripts/install_ffmpeg.sh; then
        echo "ffmpeg 安装成功。"
        export PATH="$PROJECT_ROOT/bin:$PATH"
    else
        echo "ffmpeg 自动安装失败。请手动运行 ./scripts/install_ffmpeg.sh 或 brew install ffmpeg"
    fi
fi

if command -v deno &> /dev/null; then
    echo "检测到 deno: $(which deno)"
elif [ -f "$HOME/.deno/bin/deno" ]; then
    echo "检测到 deno: $HOME/.deno/bin/deno"
    export PATH="$HOME/.deno/bin:$PATH"
else
    echo "警告：未检测到 deno。yt-dlp 解析 YouTube 可能需要 deno。"
    echo "推荐安装: https://docs.deno.com/runtime/getting_started/installation/"
fi

echo "环境初始化完成！"
echo "请使用 'source venv/bin/activate' 激活虚拟环境。"
