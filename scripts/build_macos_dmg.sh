#!/usr/bin/env bash
# 构建 macOS .app / DMG（默认可未签名）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="${ROOT}/desktop"

FETCH_BINS="${FETCH_BINS:-1}"
BUILD_SIDECAR="${BUILD_SIDECAR:-1}"

if [[ "${FETCH_BINS}" == "1" ]]; then
  "${ROOT}/scripts/fetch_release_binaries.sh"
fi
if [[ "${BUILD_SIDECAR}" == "1" ]]; then
  "${ROOT}/scripts/build_sidecar.sh"
fi

SIDECAR_BIN="${DESKTOP}/resources/sidecar/DownanySidecar/DownanySidecar"
if [[ ! -x "${SIDECAR_BIN}" ]]; then
  SIDECAR_BIN="${DESKTOP}/resources/sidecar/DownanySidecar"
fi
if [[ ! -x "${SIDECAR_BIN}" ]]; then
  echo "缺少 Sidecar 二进制，请先 scripts/build_sidecar.sh" >&2
  exit 1
fi

if [[ ! -x "${DESKTOP}/resources/bin/ffmpeg" ]]; then
  echo "缺少 ffmpeg，请先 scripts/fetch_release_binaries.sh" >&2
  exit 1
fi

cd "${DESKTOP}"
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
