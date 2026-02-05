#!/bin/bash
# 启动 Downloader 应用

# 获取当前工作目录作为项目根目录
PROJECT_ROOT=$(pwd)

if [ -f "$PROJECT_ROOT/src/main.py" ]; then
    echo "正在启动 Downloader 应用..."
else
    echo "错误: 在 $PROJECT_ROOT 下未找到 src/main.py"
    echo "请在项目根目录下运行此技能。"
    exit 1
fi

# 检查是否存在 venv
VENV_PYTHON="$PROJECT_ROOT/venv/bin/python"
if [ -x "$VENV_PYTHON" ]; then
    PYTHON_EXEC="$VENV_PYTHON"
    echo "使用虚拟环境: $VENV_PYTHON"
else
    # 优先使用 python3，如果不存在则尝试 python
    if command -v python3 &> /dev/null; then
        PYTHON_EXEC="python3"
    else
        PYTHON_EXEC="python"
    fi
    echo "未找到虚拟环境，使用系统 Python: $PYTHON_EXEC"
fi

# 设置 PYTHONPATH 以包含 src 目录
export PYTHONPATH=$PROJECT_ROOT:$PYTHONPATH

# 尝试自动查找 Qt 插件路径 (针对 macOS)
if [ "$(uname)" == "Darwin" ]; then
    # 使用选定的 Python 解释器查找路径
    PYQT6_PATH=$($PYTHON_EXEC -c "import os; import PyQt6; print(os.path.dirname(PyQt6.__file__))" 2>/dev/null)
    if [ -n "$PYQT6_PATH" ]; then
         PLUGIN_PATH="$PYQT6_PATH/Qt6/plugins"
         if [ -d "$PLUGIN_PATH" ]; then
             export QT_PLUGIN_PATH=$PLUGIN_PATH
             export QT_QPA_PLATFORM_PLUGIN_PATH=$PLUGIN_PATH/platforms
             echo "已设置 Qt 插件路径: $PLUGIN_PATH"
         fi
    fi
fi

# 运行应用
$PYTHON_EXEC "$PROJECT_ROOT/src/main.py"
