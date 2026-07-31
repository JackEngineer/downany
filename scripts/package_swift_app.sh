#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="${ROOT_DIR}/legacy/swift-app"
CONFIGURATION="${CONFIGURATION:-release}"
PRODUCT_NAME="${PRODUCT_NAME:-TraeDownloaderApp}"
BUNDLE_NAME="${BUNDLE_NAME:-TraeDownloader}"
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/dist}"
APP_BUNDLE="${OUTPUT_DIR}/${BUNDLE_NAME}.app"
INFO_PLIST_SOURCE="${PACKAGE_DIR}/Resources/Info.plist"
ICON_SVG_SOURCE="${PACKAGE_DIR}/Resources/AppIcon.svg"
EXECUTABLE_DEST="${APP_BUNDLE}/Contents/MacOS/${PRODUCT_NAME}"
RESOURCES_DIR="${APP_BUNDLE}/Contents/Resources"
SIGN_IDENTITY="${SIGN_IDENTITY:-}"
VERIFY_CODESIGN="${VERIFY_CODESIGN:-1}"

resolve_dependency() {
    local name="$1"

    case "${name}" in
        yt-dlp)
            if [[ -n "${YTDLP_PATH:-}" ]]; then
                printf '%s\n' "${YTDLP_PATH}"
                return 0
            fi
            ;;
        ffmpeg)
            if [[ -n "${FFMPEG_PATH:-}" ]]; then
                printf '%s\n' "${FFMPEG_PATH}"
                return 0
            fi
            ;;
    esac

    if [[ -x "${ROOT_DIR}/bin/${name}" ]]; then
        printf '%s\n' "${ROOT_DIR}/bin/${name}"
    elif [[ -x "${PACKAGE_DIR}/bin/${name}" ]]; then
        printf '%s\n' "${PACKAGE_DIR}/bin/${name}"
    else
        command -v "${name}" || true
    fi
}

warn_if_not_standalone() {
    local name="$1"
    local path="$2"
    local first_line=""
    local override_name=""

    if [[ ! -f "${path}" ]]; then
        return 0
    fi

    if ! file "${path}" | grep -qi "text"; then
        return 0
    fi

    first_line="$(LC_ALL=C sed -n '1p' "${path}" 2>/dev/null || true)"
    if [[ "${first_line}" == '#!'* && "${first_line}" != '#!/bin/sh'* && "${first_line}" != '#!/usr/bin/env'* ]]; then
        case "${name}" in
            yt-dlp) override_name="YTDLP_PATH" ;;
            ffmpeg) override_name="FFMPEG_PATH" ;;
            *) override_name="custom path variable" ;;
        esac
        echo "warning: bundled ${name} uses external interpreter: ${first_line}" >&2
        echo "warning: set ${override_name} to a standalone executable for portable distribution" >&2
    fi
}

copy_dependency() {
    local name="$1"
    local source_path=""

    source_path="$(resolve_dependency "${name}")"

    if [[ -z "${source_path}" ]]; then
        echo "warning: ${name} not found, the app will rely on PATH at runtime" >&2
        return 0
    fi

    if [[ ! -x "${source_path}" ]]; then
        echo "warning: ${name} is not executable: ${source_path}" >&2
        return 0
    fi

    cp "${source_path}" "${RESOURCES_DIR}/${name}"
    chmod 755 "${RESOURCES_DIR}/${name}"
    warn_if_not_standalone "${name}" "${RESOURCES_DIR}/${name}"
}

generate_icon() {
    local iconset_dir="${OUTPUT_DIR}/AppIcon.iconset"
    local base_png="${OUTPUT_DIR}/AppIcon.png"
    local preview_png="${OUTPUT_DIR}/AppIcon.svg.png"
    local icon_dest="${RESOURCES_DIR}/AppIcon.icns"

    if [[ -f "${PACKAGE_DIR}/Resources/AppIcon.icns" ]]; then
        cp "${PACKAGE_DIR}/Resources/AppIcon.icns" "${icon_dest}"
        return 0
    fi

    if [[ ! -f "${ICON_SVG_SOURCE}" ]]; then
        return 0
    fi

    if ! command -v qlmanage >/dev/null || ! command -v sips >/dev/null || ! command -v iconutil >/dev/null; then
        echo "warning: icon tools unavailable, skipping AppIcon.icns generation" >&2
        return 0
    fi

    rm -rf "${iconset_dir}" "${base_png}" "${preview_png}"
    mkdir -p "${iconset_dir}"

    if ! qlmanage -t -s 1024 -o "${OUTPUT_DIR}" "${ICON_SVG_SOURCE}" >/dev/null 2>&1; then
        echo "warning: failed to render ${ICON_SVG_SOURCE}, skipping AppIcon.icns generation" >&2
        return 0
    fi

    if [[ ! -f "${preview_png}" ]]; then
        echo "warning: failed to render ${ICON_SVG_SOURCE}, skipping AppIcon.icns generation" >&2
        return 0
    fi

    mv "${preview_png}" "${base_png}"

    sips -z 16 16 "${base_png}" --out "${iconset_dir}/icon_16x16.png" >/dev/null
    sips -z 32 32 "${base_png}" --out "${iconset_dir}/icon_16x16@2x.png" >/dev/null
    sips -z 32 32 "${base_png}" --out "${iconset_dir}/icon_32x32.png" >/dev/null
    sips -z 64 64 "${base_png}" --out "${iconset_dir}/icon_32x32@2x.png" >/dev/null
    sips -z 128 128 "${base_png}" --out "${iconset_dir}/icon_128x128.png" >/dev/null
    sips -z 256 256 "${base_png}" --out "${iconset_dir}/icon_128x128@2x.png" >/dev/null
    sips -z 256 256 "${base_png}" --out "${iconset_dir}/icon_256x256.png" >/dev/null
    sips -z 512 512 "${base_png}" --out "${iconset_dir}/icon_256x256@2x.png" >/dev/null
    sips -z 512 512 "${base_png}" --out "${iconset_dir}/icon_512x512.png" >/dev/null
    sips -z 1024 1024 "${base_png}" --out "${iconset_dir}/icon_512x512@2x.png" >/dev/null

    if ! iconutil -c icns "${iconset_dir}" -o "${icon_dest}"; then
        echo "warning: failed to create ${icon_dest}" >&2
    fi

    rm -rf "${iconset_dir}" "${base_png}"
}

sign_if_requested() {
    if [[ -z "${SIGN_IDENTITY}" ]]; then
        return 0
    fi

    if [[ -x "${RESOURCES_DIR}/ffmpeg" ]] && file "${RESOURCES_DIR}/ffmpeg" | grep -q "Mach-O"; then
        codesign --force --sign "${SIGN_IDENTITY}" --timestamp=none "${RESOURCES_DIR}/ffmpeg"
    fi

    if [[ -x "${RESOURCES_DIR}/yt-dlp" ]] && file "${RESOURCES_DIR}/yt-dlp" | grep -q "Mach-O"; then
        codesign --force --sign "${SIGN_IDENTITY}" --timestamp=none "${RESOURCES_DIR}/yt-dlp"
    fi

    codesign --force --deep --sign "${SIGN_IDENTITY}" --timestamp=none "${APP_BUNDLE}"

    if [[ "${VERIFY_CODESIGN}" == "1" ]]; then
        codesign --verify --deep --strict --verbose=2 "${APP_BUNDLE}"
    fi
}

if [[ ! -f "${INFO_PLIST_SOURCE}" ]]; then
    echo "missing Info.plist: ${INFO_PLIST_SOURCE}" >&2
    exit 1
fi

swift build --package-path "${PACKAGE_DIR}" -c "${CONFIGURATION}" --product "${PRODUCT_NAME}"

BIN_DIR="$(swift build --package-path "${PACKAGE_DIR}" -c "${CONFIGURATION}" --show-bin-path)"
EXECUTABLE_SOURCE="${BIN_DIR}/${PRODUCT_NAME}"

if [[ ! -x "${EXECUTABLE_SOURCE}" ]]; then
    echo "missing built executable: ${EXECUTABLE_SOURCE}" >&2
    exit 1
fi

rm -rf "${APP_BUNDLE}"
mkdir -p "${RESOURCES_DIR}" "$(dirname "${EXECUTABLE_DEST}")"

cp "${EXECUTABLE_SOURCE}" "${EXECUTABLE_DEST}"
chmod 755 "${EXECUTABLE_DEST}"

cp "${INFO_PLIST_SOURCE}" "${APP_BUNDLE}/Contents/Info.plist"

printf 'APPL????' > "${APP_BUNDLE}/Contents/PkgInfo"

generate_icon
copy_dependency yt-dlp
copy_dependency ffmpeg
sign_if_requested

echo "Created ${APP_BUNDLE}"
