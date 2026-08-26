#!/usr/bin/env bash
# 构建 macOS .app / DMG（默认可未签名）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="${ROOT}/desktop"

FETCH_BINS="${FETCH_BINS:-1}"
BUILD_SIDECAR="${BUILD_SIDECAR:-1}"
BUILD_TELEGRAM_NATIVE="${BUILD_TELEGRAM_NATIVE:-1}"
ALLOW_CLOUD_ONLY_PACKAGE="${ALLOW_CLOUD_ONLY_PACKAGE:-0}"

if [[ "${FETCH_BINS}" == "1" ]]; then
  "${ROOT}/scripts/fetch_release_binaries.sh"
fi
if [[ "${BUILD_SIDECAR}" == "1" ]]; then
  "${ROOT}/scripts/build_sidecar.sh"
fi
if [[ "${BUILD_TELEGRAM_NATIVE}" == "1" ]]; then
  "${ROOT}/scripts/build_telegram_bot_api_macos.sh"
  "${ROOT}/scripts/build_process_host_macos.sh"
fi

SIDECAR_BIN="${DESKTOP}/resources/sidecar/DownanySidecar/DownanySidecar"
if [[ ! -x "${SIDECAR_BIN}" ]]; then
  SIDECAR_BIN="${DESKTOP}/resources/sidecar/DownanySidecar"
fi
if [[ ! -x "${SIDECAR_BIN}" ]]; then
  echo "缺少 Sidecar 二进制，请先 scripts/build_sidecar.sh" >&2
  exit 1
fi

MEDIA_BIN="${DESKTOP}/resources/bin"
for media_tool in ffmpeg ffprobe; do
  if [[ ! -x "${MEDIA_BIN}/${media_tool}" ]]; then
    echo "缺少可执行的 ${media_tool}，请先 scripts/fetch_release_binaries.sh" >&2
    exit 1
  fi
done

echo "==> 媒体工具成对冒烟"
node "${ROOT}/scripts/test_packaged_media_tools.mjs" --bin-dir="${MEDIA_BIN}"

if [[ "${ALLOW_CLOUD_ONLY_PACKAGE}" != "1" ]]; then
  TELEGRAM_ROOT="${DESKTOP}/resources/telegram-bot-api"
  TELEGRAM_BIN="${TELEGRAM_ROOT}/telegram-bot-api"
  TELEGRAM_CREDENTIALS="${TELEGRAM_ROOT}/app-credentials.json"
  TELEGRAM_MANIFEST="${TELEGRAM_ROOT}/manifest.json"
  PROCESS_HOST="${DESKTOP}/resources/process-host/DownanyProcessHost"
  PROCESS_HOST_MANIFEST="${DESKTOP}/resources/process-host/process-host-manifest.json"
  for required in "${TELEGRAM_BIN}" "${TELEGRAM_CREDENTIALS}" "${TELEGRAM_MANIFEST}" "${PROCESS_HOST}" "${PROCESS_HOST_MANIFEST}"; do
    [[ -f "${required}" ]] || { echo "缺少 Telegram 本地模式资源: ${required}；请先构建原生资源并生成 app-credentials.json；仅云端开发包可设置 ALLOW_CLOUD_ONLY_PACKAGE=1" >&2; exit 1; }
  done
  python3 - "${TELEGRAM_MANIFEST}" "${TELEGRAM_BIN}" "${TELEGRAM_CREDENTIALS}" "${PROCESS_HOST_MANIFEST}" "${PROCESS_HOST}" <<'PY'
import hashlib, json, pathlib, re, sys
manifest_path, binary_path, credentials_path = map(pathlib.Path, sys.argv[1:4])
host_manifest_path = pathlib.Path(sys.argv[4])
host_binary_path = pathlib.Path(sys.argv[5])
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
if manifest.get("platform") != "darwin-arm64" or manifest.get("executable") != "telegram-bot-api" or not re.fullmatch(r"[0-9a-f]{64}", str(manifest.get("sha256", ""))):
    raise SystemExit("Telegram manifest platform/executable/sha256 invalid")
actual = hashlib.sha256(binary_path.read_bytes()).hexdigest()
if actual != manifest["sha256"]:
    raise SystemExit("Telegram Bot API manifest SHA256 mismatch")
credentials = json.loads(credentials_path.read_text(encoding="utf-8"))
if credentials.get("schemaVersion") != 1 or not re.fullmatch(r"[1-9][0-9]*", str(credentials.get("apiId", ""))) or not re.fullmatch(r"[0-9a-fA-F]{32}", str(credentials.get("apiHash", ""))):
    raise SystemExit("app-credentials.json schema/API credentials invalid")
host_manifest = json.loads(host_manifest_path.read_text(encoding="utf-8"))
if (host_manifest.get("schemaVersion") != 1 or host_manifest.get("platform") != "darwin-arm64" or host_manifest.get("executable") != "DownanyProcessHost" or not re.fullmatch(r"[0-9a-f]{64}", str(host_manifest.get("sha256", ""))) or int(host_manifest.get("bytes", 0)) <= 4096):
    raise SystemExit("ProcessHost manifest platform/executable/sha256/bytes invalid")
host_actual = hashlib.sha256(host_binary_path.read_bytes()).hexdigest()
if host_actual != host_manifest["sha256"] or host_binary_path.stat().st_size != int(host_manifest["bytes"]):
    raise SystemExit("ProcessHost manifest SHA256/bytes mismatch")
PY
fi

cd "${DESKTOP}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-${ROOT}/.build/npm-cache}"
mkdir -p -- "${NPM_CONFIG_CACHE}"
# npm ci 在干净 checkout 上用；本地增量构建用 npm install 亦可
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
npm run build

export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"
rm -rf "${DESKTOP}/release"
npm run dist:mac

echo "==> 产物目录: ${DESKTOP}/release"
ls -la "${DESKTOP}/release" || true
