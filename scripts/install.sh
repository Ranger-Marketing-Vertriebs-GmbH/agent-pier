#!/bin/sh
set -eu
# Bootstrap only a private temporary Node runtime; the release carries its own runtime.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&b>=13?0:1)' >/dev/null 2>&1; then
  exec node "$SCRIPT_DIR/release-install.mjs" "$@"
fi
case $(uname -s) in Darwin) PLATFORM=darwin;; Linux) PLATFORM=linux;; *) echo 'Unsupported operating system.' >&2; exit 1;; esac
case $(uname -m) in arm64|aarch64) ARCH=arm64;; x86_64) ARCH=x64;; *) echo 'Unsupported architecture.' >&2; exit 1;; esac
TEMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TEMP_ROOT"' EXIT HUP INT TERM
VERSION=22.22.2
NAME="node-v$VERSION-$PLATFORM-$ARCH"
BASE="https://nodejs.org/dist/v$VERSION"
curl --fail --location --proto '=https' --tlsv1.2 "$BASE/SHASUMS256.txt" -o "$TEMP_ROOT/checksums"
curl --fail --location --proto '=https' --tlsv1.2 "$BASE/$NAME.tar.gz" -o "$TEMP_ROOT/node.tar.gz"
EXPECTED=$(awk -v name="$NAME.tar.gz" '$2==name { print $1 }' "$TEMP_ROOT/checksums")
if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$TEMP_ROOT/node.tar.gz" | awk '{print $1}'); else ACTUAL=$(shasum -a 256 "$TEMP_ROOT/node.tar.gz" | awk '{print $1}'); fi
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo 'Official Node checksum mismatch.' >&2; exit 1; }
tar -xzf "$TEMP_ROOT/node.tar.gz" -C "$TEMP_ROOT" --strip-components 2 "$NAME/bin/node"
"$TEMP_ROOT/node" "$SCRIPT_DIR/release-install.mjs" "$@"
