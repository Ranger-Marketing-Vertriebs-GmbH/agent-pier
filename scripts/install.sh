#!/bin/sh
set -eu
# Bootstrap only a private temporary Node runtime; the release carries its own runtime.
PATH="${PATH:+$PATH:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/install-bootstrap.sh"
if [ "${1:-}" = --setup ]; then
  shift
  validate_setup_options "$@"
  INSTALL_TARGET="$SCRIPT_DIR/setup-options.mjs"
else
  validate_installer_options "$@"
  INSTALL_TARGET="$SCRIPT_DIR/release-install.mjs"
fi
# Behind a proxy, Node's fetch needs NODE_USE_ENV_PROXY (Node 22.21+); loopback
# health checks must never be sent to the proxy.
NODE_ROUTE=direct
if [ -n "${HTTPS_PROXY:-}${https_proxy:-}${HTTP_PROXY:-}${http_proxy:-}" ]; then
  NODE_USE_ENV_PROXY=1
  NO_PROXY="${NO_PROXY:+$NO_PROXY,}${no_proxy:+$no_proxy,}localhost,127.0.0.1,::1,[::1]"
  no_proxy=$NO_PROXY
  export NODE_USE_ENV_PROXY NO_PROXY no_proxy
  NODE_ROUTE=proxy
fi
# Host Node must be a patched release (Oct 2026 security releases): ^22.23.4 || ^24.22.1 || >=26.12.1
if command -v node >/dev/null 2>&1 && node -e 'const v=process.versions.node.split(".").map(Number),[a,b,c]=v,ge=(x,y,z)=>b>y||b===y&&c>=z;process.exit((a===22&&ge(0,23,4)||a===24&&ge(0,22,1)||a>26||a===26&&ge(0,12,1))?0:1)' >/dev/null 2>&1; then
  exec node "$INSTALL_TARGET" "$@"
fi
case $(uname -s) in Darwin) PLATFORM=darwin;; Linux) PLATFORM=linux;; *) echo 'Unsupported operating system.' >&2; exit 1;; esac
case $(uname -m) in arm64|aarch64) ARCH=arm64;; x86_64) ARCH=x64;; *) echo 'Unsupported architecture.' >&2; exit 1;; esac
ensure_bootstrap_tools "$@"
TEMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TEMP_ROOT"' EXIT HUP INT TERM
VERSION=22.23.4
NAME="node-v$VERSION-$PLATFORM-$ARCH"
BASE="https://nodejs.org/dist/v$VERSION"
curl --fail --location --proto '=https' --tlsv1.2 "$BASE/SHASUMS256.txt" -o "$TEMP_ROOT/checksums"
curl --fail --location --proto '=https' --tlsv1.2 "$BASE/$NAME.tar.gz" -o "$TEMP_ROOT/node.tar.gz"
EXPECTED=$(awk -v name="$NAME.tar.gz" '$2==name { print $1 }' "$TEMP_ROOT/checksums")
if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$TEMP_ROOT/node.tar.gz" | awk '{print $1}'); else ACTUAL=$(shasum -a 256 "$TEMP_ROOT/node.tar.gz" | awk '{print $1}'); fi
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo 'Official Node checksum mismatch.' >&2; exit 1; }
tar -xzf "$TEMP_ROOT/node.tar.gz" -C "$TEMP_ROOT" --strip-components 2 "$NAME/bin/node"
PATH="$TEMP_ROOT:$PATH"
export PATH
"$TEMP_ROOT/node" "$INSTALL_TARGET" "$@"
