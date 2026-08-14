#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${ROOT}/native/process-host"
BUILD="${ROOT}/.build/process-host-macos"
RESOURCE="${ROOT}/desktop/resources/process-host"
EXECUTABLE="${RESOURCE}/DownanyProcessHost"

fail() { echo "ProcessHost 构建失败：$*" >&2; exit 1; }
[[ "$(uname -s)" == "Darwin" ]] || fail "必须在 macOS 上运行"
[[ "$(uname -m)" == "arm64" ]] || fail "只接受 Apple Silicon arm64"
command -v cmake >/dev/null 2>&1 || fail "缺少 cmake"
command -v clang++ >/dev/null 2>&1 || fail "缺少 clang++"
[[ -d "${SOURCE}" ]] || fail "缺少源码目录 ${SOURCE}"

build_root="${ROOT}/.build"
case "${BUILD}" in
  "${build_root}"/*) ;;
  *) fail "拒绝越界 build 目录" ;;
esac
rm -rf -- "${BUILD}"
mkdir -p -- "${BUILD}" "${RESOURCE}"

cmake -S "${SOURCE}" -B "${BUILD}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0
cmake --build "${BUILD}" --config Release --target DownanyProcessHost

BUILT="${BUILD}/DownanyProcessHost"
[[ -x "${BUILT}" ]] || fail "构建输出不存在：${BUILT}"
TMP="${RESOURCE}/.DownanyProcessHost.$$.tmp"
trap 'rm -f -- "${TMP}"' EXIT
cp -- "${BUILT}" "${TMP}"
chmod 0755 -- "${TMP}"
mv -f -- "${TMP}" "${EXECUTABLE}"
HASH="$(shasum -a 256 "${EXECUTABLE}" | awk '{print tolower($1)}')"
BYTES="$(wc -c < "${EXECUTABLE}" | tr -d ' ')"
python3 - "${RESOURCE}/process-host-manifest.json" "${HASH}" "${BYTES}" <<'PY'
import json, pathlib, sys
out, digest, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
pathlib.Path(out).write_text(json.dumps({
    "schemaVersion": 1,
    "platform": "darwin-arm64",
    "sourceDisposition": "project_source",
    "executable": "DownanyProcessHost",
    "sha256": digest,
    "bytes": size,
}, separators=(",", ":")) + "\n", encoding="utf-8")
PY
echo "ProcessHost ready: ${EXECUTABLE} (${HASH})"
