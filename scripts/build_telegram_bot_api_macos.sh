#!/usr/bin/env bash
set -euo pipefail

# Build the pinned official Telegram Bot API server for Apple Silicon.  The
# script is intentionally strict: it never falls back to Homebrew's floating
# OpenSSL/zlib and never stages a binary when a lock or architecture check
# fails.

die() { printf 'Telegram Bot API macOS build failed: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
LOCK_PATH="${REPO_ROOT}/packaging/telegram-bot-api/source.lock.json"
BUILD_ROOT="${REPO_ROOT}/.build/telegram-bot-api/macos"
SOURCE_ROOT="${BUILD_ROOT}/source"
SOURCE_BUILD_ROOT="${BUILD_ROOT}/source-build"
STAGE_ROOT="${BUILD_ROOT}/stage"
DOWNLOAD_ROOT="${BUILD_ROOT}/downloads"
RESOURCE_ROOT="${REPO_ROOT}/desktop/resources/telegram-bot-api"

[ -d "${REPO_ROOT}/.git" ] || die "repository root not found"
[ -f "${LOCK_PATH}" ] || die "source.lock.json not found"
[ "$(uname -s)" = "Darwin" ] || die "this script must run on macOS"
[ "$(uname -m)" = "arm64" ] || die "only Apple Silicon arm64 is supported"

for command_name in git cmake brew gperf curl tar shasum python3 lipo otool; do need "${command_name}"; done

lock_get() {
  python3 - "$LOCK_PATH" "$1" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
value = data
for part in sys.argv[2].split('.'):
    value = value[part]
print(value)
PY
}

SOURCE_URL="$(lock_get repository)"
SOURCE_COMMIT="$(lock_get commit)"
OPENSSL_URL="$(lock_get macosOpenSSL.url)"
OPENSSL_SHA="$(lock_get macosOpenSSL.sha256)"
ZLIB_URL="$(lock_get zlib.url)"
ZLIB_SHA="$(lock_get zlib.sha256)"
DEPLOYMENT_TARGET="$(lock_get macosDeploymentTarget)"
[ "$(lock_get macosOpenSSL.version)" = "3.6.3" ] || die "unexpected OpenSSL lock"
[ "$(lock_get zlib.version)" = "1.3.2" ] || die "unexpected zlib lock"
[ "${DEPLOYMENT_TARGET}" = "11.0" ] || die "unexpected macOS deployment target"

assert_inside() {
  local child parent
  child="$(python3 - "$1" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
  parent="$(python3 - "$2" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]).rstrip(os.sep) + os.sep)
PY
)"
  case "${child}" in "${parent}"*) ;; *) die "$3 escaped containment" ;; esac
}

safe_clear_dir() {
  local directory="$1" parent="$2" label="$3"
  assert_inside "${directory}" "${parent}" "${label}"
  if [ -e "${directory}" ] || [ -L "${directory}" ]; then
    [ ! -L "${directory}" ] || die "${label} is a symlink"
  else
    mkdir -p "${directory}"
    return
  fi
  while IFS= read -r -d '' child; do
    [ ! -L "${child}" ] || die "${label} contains a symlink: ${child}"
  done < <(find "${directory}" -mindepth 1 -maxdepth 1 -print0)
  while IFS= read -r -d '' child; do
    [ "$(basename "${child}")" = ".gitkeep" ] || rm -rf -- "${child}"
  done < <(find "${directory}" -mindepth 1 -maxdepth 1 -print0)
}

safe_clear_dir "${BUILD_ROOT}" "${REPO_ROOT}/.build" "build root"
safe_clear_dir "${RESOURCE_ROOT}" "${REPO_ROOT}/desktop/resources" "resource root"
mkdir -p "${DOWNLOAD_ROOT}" "${SOURCE_BUILD_ROOT}" "${STAGE_ROOT}"

git clone --recursive "${SOURCE_URL}" "${SOURCE_ROOT}"
git -C "${SOURCE_ROOT}" checkout --detach "${SOURCE_COMMIT}"
git -C "${SOURCE_ROOT}" submodule sync --recursive
git -C "${SOURCE_ROOT}" submodule update --init --recursive
[ "$(git -C "${SOURCE_ROOT}" rev-parse HEAD)" = "${SOURCE_COMMIT}" ] || die "source commit mismatch"

download_locked() {
  local url="$1" expected="$2" output="$3" temporary="${output}.download.$$"
  curl --fail --location --retry 3 --silent --show-error "${url}" -o "${temporary}"
  [ "$(shasum -a 256 "${temporary}" | awk '{print tolower($1)}')" = "${expected}" ] || {
    rm -f -- "${temporary}"
    die "SHA256 mismatch for ${url}"
  }
  mv -f -- "${temporary}" "${output}"
}

OPENSSL_ARCHIVE="${DOWNLOAD_ROOT}/openssl.tar.gz"
ZLIB_ARCHIVE="${DOWNLOAD_ROOT}/zlib.tar.gz"
download_locked "${OPENSSL_URL}" "${OPENSSL_SHA}" "${OPENSSL_ARCHIVE}"
download_locked "${ZLIB_URL}" "${ZLIB_SHA}" "${ZLIB_ARCHIVE}"

OPENSSL_SOURCE="${BUILD_ROOT}/openssl-source"
ZLIB_SOURCE="${BUILD_ROOT}/zlib-source"
OPENSSL_STAGE="${BUILD_ROOT}/openssl-stage"
ZLIB_STAGE="${BUILD_ROOT}/zlib-stage"
mkdir -p "${OPENSSL_SOURCE}" "${ZLIB_SOURCE}" "${OPENSSL_STAGE}" "${ZLIB_STAGE}"
tar -xzf "${OPENSSL_ARCHIVE}" -C "${OPENSSL_SOURCE}" --strip-components=1
tar -xzf "${ZLIB_ARCHIVE}" -C "${ZLIB_SOURCE}" --strip-components=1

export MACOSX_DEPLOYMENT_TARGET="${DEPLOYMENT_TARGET}"
export CC="$(xcrun --find clang)"
export CFLAGS="-O2 -arch arm64 -mmacosx-version-min=${DEPLOYMENT_TARGET}"
export LDFLAGS="-arch arm64 -mmacosx-version-min=${DEPLOYMENT_TARGET}"

pushd "${OPENSSL_SOURCE}" >/dev/null
./Configure darwin64-arm64-cc no-shared no-tests no-module \
  --prefix="${OPENSSL_STAGE}" --openssldir="${OPENSSL_STAGE}/ssl" --libdir=lib \
  -arch arm64 -mmacosx-version-min="${DEPLOYMENT_TARGET}"
make -j"$(sysctl -n hw.ncpu)"
make install_sw
popd >/dev/null
[ -f "${OPENSSL_STAGE}/lib/libssl.a" ] && [ -f "${OPENSSL_STAGE}/lib/libcrypto.a" ] || die "static OpenSSL was not staged"

pushd "${ZLIB_SOURCE}" >/dev/null
./configure --static --prefix="${ZLIB_STAGE}"
make -j"$(sysctl -n hw.ncpu)"
make install
popd >/dev/null
[ -f "${ZLIB_STAGE}/lib/libz.a" ] && [ -f "${ZLIB_STAGE}/include/zlib.h" ] || die "static zlib was not staged"

export PATH="$(brew --prefix gperf)/bin:${PATH}"
cmake -S "${SOURCE_ROOT}" -B "${SOURCE_BUILD_ROOT}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET:STRING="${DEPLOYMENT_TARGET}" \
  -DOPENSSL_ROOT_DIR="${OPENSSL_STAGE}" -DOPENSSL_USE_STATIC_LIBS=TRUE \
  -DZLIB_ROOT="${ZLIB_STAGE}" -DZLIB_LIBRARY:FILEPATH="${ZLIB_STAGE}/lib/libz.a" \
  -DZLIB_INCLUDE_DIR:PATH="${ZLIB_STAGE}/include" \
  "-DCMAKE_PREFIX_PATH=${OPENSSL_STAGE};${ZLIB_STAGE}" \
  -DCMAKE_INSTALL_PREFIX="${STAGE_ROOT}"
cmake --build "${SOURCE_BUILD_ROOT}" --target install --parallel

BUILT=()
while IFS= read -r built_path; do
  BUILT+=("${built_path}")
done < <(find "${STAGE_ROOT}" -type f -name telegram-bot-api -perm -111 -print)
[ "${#BUILT[@]}" -eq 1 ] || die "expected one staged telegram-bot-api executable"
TELEGRAM_BIN="${BUILT[0]}"
"${TELEGRAM_BIN}" --help >/dev/null
[ "$(lipo -archs "${TELEGRAM_BIN}")" = "arm64" ] || die "telegram-bot-api is not arm64-only"
if otool -L "${TELEGRAM_BIN}" | grep -E '(/opt/homebrew|/usr/local|\.build|@rpath|@loader_path|@executable_path)' >/dev/null; then
  die "telegram-bot-api has an unapproved dynamic dependency"
fi

cp -f -- "${TELEGRAM_BIN}" "${RESOURCE_ROOT}/telegram-bot-api"
python3 - "${RESOURCE_ROOT}/telegram-bot-api" "${RESOURCE_ROOT}/manifest.json" "${SOURCE_COMMIT}" <<'PY'
import hashlib, json, os, sys
binary, manifest_path, commit = sys.argv[1:]
with open(binary, 'rb') as handle:
    digest = hashlib.sha256(handle.read()).hexdigest()
manifest = {
    'schemaVersion': 1,
    'platform': 'darwin-arm64',
    'sourceCommit': commit,
    'executable': 'telegram-bot-api',
    'size': os.path.getsize(binary),
    'sha256': digest,
}
with open(manifest_path, 'w', encoding='utf-8', newline='\n') as handle:
    json.dump(manifest, handle, ensure_ascii=False, separators=(',', ':'))
    handle.write('\n')
PY
printf 'OK: staged %s\n' "${RESOURCE_ROOT}/telegram-bot-api"
