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
# 清掉旧 onefile 单文件，避免与 onedir 目录同名冲突
rm -rf "${OUT}"
mkdir -p "${BUILD_DIR}" "${OUT}"
cd "${ROOT}"
"${PYTHON}" -m PyInstaller \
  --noconfirm \
  --clean \
  --distpath "${OUT}" \
  --workpath "${BUILD_DIR}/work" \
  "${SPEC}"

# onedir: OUT/VideoDownloaderSidecar/VideoDownloaderSidecar
# onefile 兼容: OUT/VideoDownloaderSidecar
SIDECAR_DIR="${OUT}/VideoDownloaderSidecar"
SIDECAR="${SIDECAR_DIR}/VideoDownloaderSidecar"
if [[ ! -x "${SIDECAR}" ]]; then
  SIDECAR="${OUT}/VideoDownloaderSidecar"
fi
if [[ ! -x "${SIDECAR}" ]]; then
  echo "未找到 Sidecar 可执行文件（期望 onedir ${SIDECAR_DIR}/VideoDownloaderSidecar）" >&2
  exit 1
fi

echo "==> 冒烟"
file "${SIDECAR}"
ls -lh "${SIDECAR}"
# 冷启动 hello 应远快于 Electron 握手超时
"${PYTHON}" - <<'PY' "${SIDECAR}"
import json, subprocess, sys, time
sidecar = sys.argv[1]
p = subprocess.Popen([sidecar], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
t0 = time.time()
line = p.stdout.readline()
latency = time.time() - t0
print(f"hello_latency={latency:.3f}s {line[:80]!r}")
if latency > 15.0:
    print("WARNING: Sidecar hello 过慢，请检查是否仍为 onefile 或磁盘过慢", file=sys.stderr)
p.terminate()
p.wait(timeout=5)
PY
echo "OK: ${SIDECAR}"

