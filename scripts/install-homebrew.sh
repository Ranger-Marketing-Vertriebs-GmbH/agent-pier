#!/bin/sh
set -eu
# Share the same bootstrap between the Node and pre-Node installer paths.
if command -v brew >/dev/null 2>&1 && brew --version >/dev/null 2>&1; then
  exit 0
fi
if ! command -v curl >/dev/null 2>&1; then
  echo 'Cannot download Homebrew: the macOS system curl is unavailable. Restore curl or install Homebrew manually, then retry.' >&2
  exit 1
fi
echo 'Installing Homebrew using its official installer. Administrator access may be required.' >&2
BREW_INSTALL_TEMP=$(mktemp -d)
trap 'rm -rf "$BREW_INSTALL_TEMP"' EXIT HUP INT TERM
curl --fail --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --connect-timeout 30 --max-time 120 \
  https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh \
  -o "$BREW_INSTALL_TEMP/install.sh"
if [ -t 0 ]; then
  /bin/bash "$BREW_INSTALL_TEMP/install.sh"
else
  NONINTERACTIVE=1 /bin/bash "$BREW_INSTALL_TEMP/install.sh"
fi
if ! command -v brew >/dev/null 2>&1 || ! brew --version >/dev/null 2>&1; then
  echo 'Homebrew is still unavailable after installation. Check the installer output and administrator access, then retry.' >&2
  exit 1
fi
