#!/usr/bin/env bash
# 可选：对 .app / DMG 签名并公证。缺少环境变量时打印说明并退出 0。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PATH="${1:-${ROOT}/desktop/release/mac-arm64/Downany.app}"
DMG_PATH="${2:-}"

SIGN_IDENTITY="${SIGN_IDENTITY:-}"
APPLE_ID="${APPLE_ID:-}"
APP_PASSWORD="${APP_PASSWORD:-}"
TEAM_ID="${TEAM_ID:-}"

if [[ -z "${SIGN_IDENTITY}" || -z "${APPLE_ID}" || -z "${APP_PASSWORD}" || -z "${TEAM_ID}" ]]; then
  cat <<'EOF'
跳过公证：需要设置环境变量
  SIGN_IDENTITY   例如 "Developer ID Application: Your Name (TEAMID)"
  APPLE_ID        Apple ID 邮箱
  APP_PASSWORD    App 专用密码
  TEAM_ID         10 位 Team ID

用法:
  SIGN_IDENTITY=... APPLE_ID=... APP_PASSWORD=... TEAM_ID=... \
    ./scripts/notarize_macos.sh [App路径] [可选DMG路径]
EOF
  exit 0
fi

if [[ ! -d "${APP_PATH}" ]]; then
  echo "找不到 app: ${APP_PATH}" >&2
  exit 1
fi

echo "==> codesign ${APP_PATH}"
codesign --force --deep --options runtime \
  --sign "${SIGN_IDENTITY}" \
  "${APP_PATH}"
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"

echo "==> notarytool submit"
ZIP="${APP_PATH}.zip"
ditto -c -k --keepParent "${APP_PATH}" "${ZIP}"
xcrun notarytool submit "${ZIP}" \
  --apple-id "${APPLE_ID}" \
  --password "${APP_PASSWORD}" \
  --team-id "${TEAM_ID}" \
  --wait
xcrun stapler staple "${APP_PATH}"

if [[ -n "${DMG_PATH}" && -f "${DMG_PATH}" ]]; then
  echo "==> 公证 DMG ${DMG_PATH}"
  xcrun notarytool submit "${DMG_PATH}" \
    --apple-id "${APPLE_ID}" \
    --password "${APP_PASSWORD}" \
    --team-id "${TEAM_ID}" \
    --wait
  xcrun stapler staple "${DMG_PATH}"
fi

echo "完成签名与公证"
