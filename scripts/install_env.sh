#!/bin/bash

# 功能：初始化开发环境
# 使用方法：./scripts/install_env.sh
# 参数说明：无

set -e

echo "正在检查 Python 环境..."
if ! command -v python3 &> /dev/null; then
    echo "错误：未找到 python3，请先安装 Python 3。"
    exit 1
fi

# 创建虚拟环境
if [ ! -d "venv" ]; then
    echo "正在创建虚拟环境 venv..."
    python3 -m venv venv
else
    echo "虚拟环境 venv 已存在。"
fi

# 激活虚拟环境并安装依赖
echo "正在激活虚拟环境并安装依赖..."
source venv/bin/activate
pip install --upgrade pip
if [ -f "requirements.txt" ]; then
    pip install -r requirements.txt
    echo "依赖安装完成。"
else
    echo "警告：未找到 requirements.txt 文件。"
fi

# 检查 ffmpeg
# 1. 优先检查本地 bin 目录
LOCAL_FFMPEG="./bin/ffmpeg"
if [ -f "$LOCAL_FFMPEG" ]; then
    echo "检测到本地 ffmpeg: $LOCAL_FFMPEG"
    # 将本地 bin 加入 PATH，以便后续使用
    export PATH="$(pwd)/bin:$PATH"
# 2. 检查系统 PATH
elif command -v ffmpeg &> /dev/null; then
    echo "检测到系统 ffmpeg: $(which ffmpeg)"
else
    echo "警告：未检测到 ffmpeg。yt-dlp 合并视频流需要 ffmpeg。"
    echo "正在尝试自动安装 ffmpeg (static binary)..."
    chmod +x ./scripts/install_ffmpeg.sh
    ./scripts/install_ffmpeg.sh
    if [ $? -eq 0 ]; then
        echo "ffmpeg 安装成功。"
        export PATH="$(pwd)/bin:$PATH"
    else
        echo "ffmpeg 自动安装失败。请手动运行 ./scripts/install_ffmpeg.sh 或 brew install ffmpeg"
    fi
fi

# 检查 deno
if command -v deno &> /dev/null; then
    echo "检测到 deno: $(which deno)"
elif [ -f "$HOME/.deno/bin/deno" ]; then
    echo "检测到 deno: $HOME/.deno/bin/deno"
    export PATH="$HOME/.deno/bin:$PATH"
else
    echo "警告：未检测到 deno。yt-dlp 解析 YouTube 可能需要 deno。"
    echo "推荐安装: curl -fsSL https://deno.land/x/install/install.sh | sh"
fi

echo "环境初始化完成！"
echo "请使用 'source venv/bin/activate' 激活虚拟环境。"
