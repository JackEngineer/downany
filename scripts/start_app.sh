#!/usr/bin/env bash
# Legacy launcher: PyQt is frozen. Prefer Electron desktop.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--pyqt" ]]; then
  echo "启动冻结的 PyQt 界面（legacy）…"
  VENV_PYTHON="$PROJECT_ROOT/venv/bin/python"
  if [[ -x "$VENV_PYTHON" ]]; then
    PYTHON_EXEC="$VENV_PYTHON"
  elif command -v python3 &>/dev/null; then
    PYTHON_EXEC="python3"
  else
    PYTHON_EXEC="python"
  fi
  export PYTHONPATH="$PROJECT_ROOT${PYTHONPATH:+:$PYTHONPATH}"
  if [[ "$(uname)" == "Darwin" ]]; then
    PYQT6_PATH=$($PYTHON_EXEC -c "import os; import PyQt6; print(os.path.dirname(PyQt6.__file__))" 2>/dev/null || true)
    if [[ -n "${PYQT6_PATH:-}" && -d "$PYQT6_PATH/Qt6/plugins" ]]; then
      export QT_QPA_PLATFORM_PLUGIN_PATH="$PYQT6_PATH/Qt6/plugins"
    fi
  fi
  exec "$PYTHON_EXEC" "$PROJECT_ROOT/legacy/main.py"
fi

echo "产品主线为 Electron。启动桌面端…"
echo "（若需旧 PyQt：scripts/start_app.sh --pyqt）"
cd "$PROJECT_ROOT/desktop"
if [[ ! -d node_modules ]]; then
  npm install
fi
exec npm run dev
