#!/usr/bin/env bash
# 一键：确保下载器在跑，并用 --load-extension 启动主 Chrome（扩展立即可用）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/browser-extension"
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [[ ! -f "$EXT/manifest.json" ]]; then
  echo "找不到扩展: $EXT" >&2
  exit 1
fi
if [[ ! -x "$CHROME_BIN" ]]; then
  echo "未找到 Google Chrome" >&2
  exit 1
fi

# 确保 Electron 在跑（注册 videodl://）
if ! pgrep -f "downloader/desktop/node_modules/electron/dist/Electron" >/dev/null 2>&1 \
  && ! pgrep -fl "VideoDownloader" >/dev/null 2>&1; then
  echo "==> 启动 Electron 下载器…"
  (
    cd "$ROOT/desktop"
    export VIDEODL_PYTHON="${VIDEODL_PYTHON:-$ROOT/venv/bin/python}"
    npm run dev
  ) >/tmp/videodl-electron-dev.log 2>&1 &
  for _ in $(seq 1 40); do
    if pgrep -f "downloader/desktop/node_modules/electron/dist/Electron" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
else
  echo "==> 下载器已在运行"
fi

echo "==> 重启 Chrome 并加载扩展…"
osascript -e 'tell application "Google Chrome" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 40); do
  if ! pgrep -x "Google Chrome" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
if pgrep -x "Google Chrome" >/dev/null 2>&1; then
  pkill -x "Google Chrome" || true
  sleep 1
fi

# 使用默认用户配置 + 官方 --load-extension（当前会话生效）
nohup "$CHROME_BIN" \
  --load-extension="$EXT" \
  --restore-last-session \
  >/tmp/videodl-chrome-main.log 2>&1 &

sleep 2
open -a "Google Chrome" "chrome://extensions"
echo "==> 完成。扩展「视频下载器」应已出现在工具栏/扩展页。"
echo "    打开视频页点图标即可入队。若完全退出 Chrome 后再开，请再跑一次本脚本。"
