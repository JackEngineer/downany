#!/usr/bin/env bash
# 启动 Electron 桌面端（产品主线）
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT/desktop"
if [[ ! -d node_modules ]]; then
  npm install
fi
exec npm run dev
