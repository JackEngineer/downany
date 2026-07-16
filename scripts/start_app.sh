#!/bin/bash
# 启动 Downloader 应用

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START_LOG="$PROJECT_ROOT/.start_app_last.log"

if [ -f "$PROJECT_ROOT/src/main.py" ]; then
    echo "正在启动 Downloader 应用..."
else
    echo "错误: 在 $PROJECT_ROOT 下未找到 src/main.py"
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
run_app() {
    local qt_platform="$1"
    local app_exit_code=0
    rm -f "$START_LOG"

    if [ -n "$qt_platform" ]; then
        export QT_QPA_PLATFORM="$qt_platform"
    else
        unset QT_QPA_PLATFORM
    fi

    "$PYTHON_EXEC" "$PROJECT_ROOT/src/main.py" 2>&1 | tee "$START_LOG"
    app_exit_code=${PIPESTATUS[0]}

    return "$app_exit_code"
}

if [ -n "${QT_QPA_PLATFORM}" ]; then
    run_app "${QT_QPA_PLATFORM}"
    APP_EXIT_CODE=$?
else
    # 首次按默认参数启动，遇到无头环境时自动回退到 offscreen
    run_app ""
    APP_EXIT_CODE=$?

    if [ "$APP_EXIT_CODE" -ne 0 ]; then
        if grep -qi "no screens available" "$START_LOG" 2>/dev/null; then
            echo "检测到当前环境无可用显示屏，自动切换到无头启动..."
            run_app offscreen
            APP_EXIT_CODE=$?
        fi
    fi
fi

rm -f "$START_LOG"
exit "$APP_EXIT_CODE"
