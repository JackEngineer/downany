#!/usr/bin/env bash
# 用 PyInstaller 构建 Sidecar 到 desktop/resources/sidecar
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/desktop/resources/sidecar"
BUILD_DIR="${ROOT}/.build/sidecar"
SPEC="${ROOT}/packaging/sidecar.spec"

PYTHON="${VIDEODL_PYTHON:-${ROOT}/venv/bin/python}"
if [[ ! -x "${PYTHON}" ]]; then
  PYTHON="$(command -v python3)"
fi

echo "==> 安装 packaging 依赖"
"${PYTHON}" -m pip install -q -r "${ROOT}/packaging/requirements-sidecar.txt"

echo "==> PyInstaller"
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}" "${OUT}"
cd "${ROOT}"
"${PYTHON}" -m PyInstaller \
  --noconfirm \
  --clean \
  --distpath "${OUT}" \
  --workpath "${BUILD_DIR}/work" \
  "${SPEC}"

SIDECAR="${OUT}/VideoDownloaderSidecar"
if [[ ! -x "${SIDECAR}" ]]; then
  echo "未找到 ${SIDECAR}" >&2
  exit 1
fi

echo "==> 冒烟"
file "${SIDECAR}"
ls -lh "${SIDECAR}"
echo "OK: ${SIDECAR}"
