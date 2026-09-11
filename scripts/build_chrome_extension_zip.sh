#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION_DIR="$ROOT/browser-extension"
OUTPUT_DIR="${1:-$ROOT/desktop/release}"
MANIFEST="$EXTENSION_DIR/manifest.json"
STAGING=""

cleanup() {
  if [[ -n "$STAGING" && -d "$STAGING" ]]; then
    rm -rf "$STAGING"
  fi
}
trap cleanup EXIT

for command_name in node zip unzip shasum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少命令：$command_name" >&2
    exit 1
  fi
done
if [[ ! -f "$MANIFEST" ]]; then
  echo "缺少扩展清单：browser-extension/manifest.json" >&2
  exit 1
fi

VERSION="$(node -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version;if(!/^\d+\.\d+\.\d+$/.test(value||""))process.exit(1);process.stdout.write(value)' "$MANIFEST")"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
ARTIFACT="$OUTPUT_DIR/Downany-chrome-extension-$VERSION.zip"
rm -f "$ARTIFACT"

STAGING="$(mktemp -d "${TMPDIR:-/tmp}/downany-extension-package.XXXXXX")"
while IFS= read -r -d '' SOURCE; do
  RELATIVE="${SOURCE#"$EXTENSION_DIR"/}"
  case "$RELATIVE" in
    *.test.js|.*|*/.*|__MACOSX*|*/__MACOSX*|*.DS_Store) continue ;;
  esac
  mkdir -p "$STAGING/$(dirname "$RELATIVE")"
  cp "$SOURCE" "$STAGING/$RELATIVE"
done < <(find "$EXTENSION_DIR" -type f -print0)
find "$STAGING" -type f -exec chmod 0644 {} +
find "$STAGING" -exec touch -t 198001010000 {} +

(
  cd "$STAGING"
  find . -type f -print | LC_ALL=C sort | zip -X -q "$ARTIFACT" -@
)

unzip -tqq "$ARTIFACT"
LISTING="$(unzip -Z1 "$ARTIFACT")"
if [[ "$(printf '%s\n' "$LISTING" | grep -c '^manifest.json$')" -ne 1 ]]; then
  echo "扩展包必须且只能包含一个根目录 manifest.json" >&2
  exit 1
fi
if printf '%s\n' "$LISTING" | grep -Eq '(^|/)(\.[^/]+|__MACOSX)(/|$)|\.test\.js$'; then
  echo "扩展包包含测试文件或隐藏文件" >&2
  exit 1
fi
PACKAGED_VERSION="$(unzip -p "$ARTIFACT" manifest.json | node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>process.stdout.write(JSON.parse(input).version||""))')"
if [[ "$PACKAGED_VERSION" != "$VERSION" ]]; then
  echo "扩展包版本与源清单不一致" >&2
  exit 1
fi

BYTES="$(wc -c < "$ARTIFACT" | tr -d ' ')"
SHA256="$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"
printf 'artifact=%s\nversion=%s\nbytes=%s\nsha256=%s\n' "$ARTIFACT" "$VERSION" "$BYTES" "$SHA256"
