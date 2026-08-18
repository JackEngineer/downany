#!/usr/bin/env bash
# scripts/install_ffmpeg.sh — 从锁定的官方源码构建 macOS arm64 静态 FFmpeg

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="${PROJECT_ROOT}/packaging/ffmpeg-macos/source.lock.json"

if [ -n "${1:-}" ]; then
    INSTALL_DIR="$1"
else
    INSTALL_DIR="${PROJECT_ROOT}/bin"
fi

if [ "$(uname -s)" != "Darwin" ]; then
    echo "FFmpeg macOS 源码构建只能在 macOS 上运行。" >&2
    exit 1
fi

if [ "$(uname -m)" != "arm64" ]; then
    echo "FFmpeg 发布构建要求 Apple Silicon arm64，当前架构为 $(uname -m)。" >&2
    exit 1
fi

for command_name in curl gcc git make python3 shasum xcrun lipo otool; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
        echo "缺少构建工具: ${command_name}" >&2
        exit 1
    fi
done

if [ ! -f "${LOCK_FILE}" ]; then
    echo "缺少 FFmpeg 源码锁文件: ${LOCK_FILE}" >&2
    exit 1
fi

LOCK_VALUES="$(python3 - "${LOCK_FILE}" <<'PY'
import json
import sys
from pathlib import Path

lock = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
lame = lock["dependencies"]["lame"]
print(
    lock["repository"],
    lock["ref"],
    lock["commit"],
    lock["version"],
    lock["target"]["architecture"],
    lock["target"]["deploymentTarget"],
    lame["url"],
    lame["sha256"],
    lame["version"],
)
PY
)"
read -r FFMPEG_REPOSITORY FFMPEG_REF FFMPEG_COMMIT FFMPEG_VERSION \
    TARGET_ARCH DEPLOYMENT_TARGET LAME_URL LAME_SHA256 LAME_VERSION <<< "${LOCK_VALUES}"

if [ "${TARGET_ARCH}" != "arm64" ]; then
    echo "源码锁文件的目标架构不是 arm64: ${TARGET_ARCH}" >&2
    exit 1
fi

SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
HOST_CC="$(xcrun --find clang)"
LAME_CC="$(command -v gcc)"
BUILD_JOBS="${FFMPEG_BUILD_JOBS:-$(sysctl -n hw.ncpu)}"
if ! [[ "${BUILD_JOBS}" =~ ^[1-9][0-9]*$ ]]; then
    echo "FFMPEG_BUILD_JOBS 必须是正整数。" >&2
    exit 1
fi

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/downany-ffmpeg.XXXXXX")"
trap 'rm -rf "${BUILD_ROOT}"' EXIT

LAME_ARCHIVE="${BUILD_ROOT}/lame-${LAME_VERSION}.tar.gz"
LAME_SOURCE="${BUILD_ROOT}/lame-${LAME_VERSION}"
LAME_STAGE="${BUILD_ROOT}/lame-stage"
FFMPEG_SOURCE="${BUILD_ROOT}/ffmpeg"
FFMPEG_STAGE="${BUILD_ROOT}/ffmpeg-stage"
FFMPEG_BIN="${FFMPEG_STAGE}/bin/ffmpeg"
TARGET_CFLAGS="-arch ${TARGET_ARCH} -mmacosx-version-min=${DEPLOYMENT_TARGET} -isysroot ${SDK_PATH}"
TARGET_LDFLAGS="-arch ${TARGET_ARCH} -mmacosx-version-min=${DEPLOYMENT_TARGET} -isysroot ${SDK_PATH}"

show_log_tail() {
    local log_file="$1"
    if [ -f "${log_file}" ]; then
        tail -n 120 "${log_file}" >&2
    fi
}

echo -e "${GREEN}开始构建 FFmpeg ${FFMPEG_VERSION} (macOS ${TARGET_ARCH})...${NC}"
echo -e "源码 commit: ${FFMPEG_COMMIT}"
echo -e "部署基线: macOS ${DEPLOYMENT_TARGET}"
echo -e "构建目录: ${BUILD_ROOT}"

echo -e "${YELLOW}下载并校验 LAME ${LAME_VERSION}...${NC}"
curl -fL --retry 3 --retry-delay 2 -o "${LAME_ARCHIVE}" "${LAME_URL}"
printf '%s  %s\n' "${LAME_SHA256}" "${LAME_ARCHIVE}" | shasum -a 256 -c -
tar -xzf "${LAME_ARCHIVE}" -C "${BUILD_ROOT}"
if [ ! -d "${LAME_SOURCE}" ]; then
    echo "LAME 源码目录不存在: ${LAME_SOURCE}" >&2
    exit 1
fi

echo -e "${YELLOW}构建静态 LAME...${NC}"
LAME_CONFIG_LOG="${BUILD_ROOT}/lame-configure.log"
LAME_BUILD_LOG="${BUILD_ROOT}/lame-build.log"
if ! (
    cd "${LAME_SOURCE}"
    ./configure \
        --prefix="${LAME_STAGE}" \
        --host="arm-apple-darwin" \
        --disable-shared \
        --enable-static \
        --disable-frontend \
        --disable-decoder \
        --disable-gtktest \
        --disable-cpml \
        CC="${LAME_CC}" \
        CFLAGS="${TARGET_CFLAGS} -fno-common" \
        LDFLAGS="${TARGET_LDFLAGS}"
) >"${LAME_CONFIG_LOG}" 2>&1; then
    echo "LAME configure 失败，最近日志：" >&2
    show_log_tail "${LAME_CONFIG_LOG}"
    exit 1
fi
if ! (
    cd "${LAME_SOURCE}"
    make -j"${BUILD_JOBS}"
) >"${LAME_BUILD_LOG}" 2>&1; then
    echo "LAME build 失败，最近日志：" >&2
    show_log_tail "${LAME_BUILD_LOG}"
    exit 1
fi
if ! (
    cd "${LAME_SOURCE}"
    make install
) >>"${LAME_BUILD_LOG}" 2>&1; then
    echo "LAME install 失败，最近日志：" >&2
    show_log_tail "${LAME_BUILD_LOG}"
    exit 1
fi
if [ ! -f "${LAME_STAGE}/lib/libmp3lame.a" ]; then
    echo "LAME 静态库未生成。" >&2
    exit 1
fi

echo -e "${YELLOW}检出并构建 FFmpeg ${FFMPEG_VERSION}...${NC}"
if ! git clone --quiet --depth 1 --branch "${FFMPEG_REF}" --single-branch \
    "${FFMPEG_REPOSITORY}" "${FFMPEG_SOURCE}"; then
    echo "FFmpeg 源码检出失败。" >&2
    exit 1
fi
ACTUAL_COMMIT="$(git -C "${FFMPEG_SOURCE}" rev-parse HEAD)"
if [ "${ACTUAL_COMMIT}" != "${FFMPEG_COMMIT}" ]; then
    echo "FFmpeg commit 校验失败。" >&2
    echo "期望: ${FFMPEG_COMMIT}" >&2
    echo "实际: ${ACTUAL_COMMIT}" >&2
    exit 1
fi

FFMPEG_CONFIG_LOG="${BUILD_ROOT}/ffmpeg-configure.log"
FFMPEG_BUILD_LOG="${BUILD_ROOT}/ffmpeg-build.log"
if ! (
    cd "${FFMPEG_SOURCE}"
    ./configure \
        --prefix="${FFMPEG_STAGE}" \
        --cc="${HOST_CC}" \
        --host-cc="${HOST_CC}" \
        --arch="${TARGET_ARCH}" \
        --target-os=darwin \
        --sysroot="${SDK_PATH}" \
        --host-cflags="-isysroot ${SDK_PATH}" \
        --host-ldflags="-isysroot ${SDK_PATH}" \
        --disable-debug \
        --disable-doc \
        --disable-ffplay \
        --disable-ffprobe \
        --disable-shared \
        --enable-static \
        --disable-gpl \
        --disable-nonfree \
        --disable-autodetect \
        --enable-securetransport \
        --enable-videotoolbox \
        --enable-audiotoolbox \
        --enable-libmp3lame \
        --extra-cflags="${TARGET_CFLAGS} -I${LAME_STAGE}/include" \
        --extra-ldflags="${TARGET_LDFLAGS} -L${LAME_STAGE}/lib" \
        --pkg-config-flags=--static
) >"${FFMPEG_CONFIG_LOG}" 2>&1; then
    echo "FFmpeg configure 失败，最近日志：" >&2
    show_log_tail "${FFMPEG_CONFIG_LOG}"
    exit 1
fi
if ! (
    cd "${FFMPEG_SOURCE}"
    make -j"${BUILD_JOBS}"
) >"${FFMPEG_BUILD_LOG}" 2>&1; then
    echo "FFmpeg build 失败，最近日志：" >&2
    show_log_tail "${FFMPEG_BUILD_LOG}"
    exit 1
fi
if ! (
    cd "${FFMPEG_SOURCE}"
    make install
) >>"${FFMPEG_BUILD_LOG}" 2>&1; then
    echo "FFmpeg install 失败，最近日志：" >&2
    show_log_tail "${FFMPEG_BUILD_LOG}"
    exit 1
fi

if [ ! -x "${FFMPEG_BIN}" ]; then
    echo "FFmpeg 可执行文件未生成: ${FFMPEG_BIN}" >&2
    exit 1
fi

ARCHES="$(lipo -archs "${FFMPEG_BIN}")"
if [ "${ARCHES}" != "${TARGET_ARCH}" ]; then
    echo "FFmpeg 架构校验失败: ${ARCHES}" >&2
    exit 1
fi

MIN_OS="$(otool -l "${FFMPEG_BIN}" | awk '$1 == "minos" { print $2; exit }')"
if [ "${MIN_OS}" != "${DEPLOYMENT_TARGET}" ]; then
    echo "FFmpeg deployment target 校验失败: ${MIN_OS}" >&2
    exit 1
fi

UNEXPECTED_DEPENDENCIES="$(
    otool -L "${FFMPEG_BIN}" |
        tail -n +2 |
        awk '{ print $1 }' |
        awk 'NF && $0 !~ /^\/System\/Library\// && $0 !~ /^\/usr\/lib\// { print }'
)"
if [ -n "${UNEXPECTED_DEPENDENCIES}" ]; then
    echo "FFmpeg 包含非系统动态依赖：" >&2
    echo "${UNEXPECTED_DEPENDENCIES}" >&2
    exit 1
fi

if ! "${FFMPEG_BIN}" -hide_banner -encoders 2>/dev/null | grep -q 'libmp3lame'; then
    echo "FFmpeg 未包含 libmp3lame 编码器。" >&2
    exit 1
fi

echo -e "${YELLOW}执行 FFmpeg 音频编解码 smoke...${NC}"
"${FFMPEG_BIN}" -hide_banner -loglevel error -y \
    -f lavfi -i "sine=frequency=1000:duration=1" \
    -c:a libmp3lame -f mp3 "${BUILD_ROOT}/probe.mp3"
"${FFMPEG_BIN}" -hide_banner -loglevel error \
    -i "${BUILD_ROOT}/probe.mp3" -f null -

mkdir -p "${INSTALL_DIR}"
INSTALL_TMP="${INSTALL_DIR}/.ffmpeg.download.$$"
install -m 0755 "${FFMPEG_BIN}" "${INSTALL_TMP}"
mv -f "${INSTALL_TMP}" "${INSTALL_DIR}/ffmpeg"
rm -f "${INSTALL_DIR}/ffmpeg.zip.sha256"
shasum -a 256 "${INSTALL_DIR}/ffmpeg" | awk '{print $1 "  ffmpeg"}' > "${INSTALL_DIR}/ffmpeg.sha256"

VERSION_OUTPUT="$("${INSTALL_DIR}/ffmpeg" -version | head -n 1)"
echo -e "${GREEN}安装成功！${NC}"
echo -e "版本信息: ${VERSION_OUTPUT}"
echo -e "架构: ${ARCHES}"
echo -e "部署基线: macOS ${MIN_OS}"
echo -e "路径: ${INSTALL_DIR}/ffmpeg"
