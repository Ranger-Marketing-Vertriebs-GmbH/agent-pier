#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/install-bootstrap.sh"
VERSION_FILE="$SCRIPT_DIR/../installer-version"

case "${1:-}" in
  --help)
    [ "$#" -eq 1 ] || { echo 'The --help option cannot be combined.' >&2; exit 1; }
    cat <<'EOF'
Usage: setup.sh [options]
  --no-service          Install without the login service
  --install-root PATH   Application installation directory
  --data-dir PATH       Private application data directory
  --skip-dependencies   Check but do not install Git and tmux
  --dependencies-only   Install missing Git and tmux only
  --help                Show this help
  --version             Show the installer version
EOF
    exit 0
    ;;
  --version)
    [ "$#" -eq 1 ] || { echo 'The --version option cannot be combined.' >&2; exit 1; }
    [ -f "$VERSION_FILE" ] || { echo 'Installer version metadata is missing.' >&2; exit 1; }
    IFS= read -r SETUP_VERSION < "$VERSION_FILE"
    case "$SETUP_VERSION" in
      ''|*[!0-9A-Za-z.-]*) echo 'Installer version metadata is invalid.' >&2; exit 1;;
    esac
    printf '%s\n' "$SETUP_VERSION"
    exit 0
    ;;
esac

validate_setup_options "$@"
[ -f "$VERSION_FILE" ] || { echo 'Installer version metadata is missing.' >&2; exit 1; }
IFS= read -r AGENTPIER_SETUP_VERSION < "$VERSION_FILE"
case "$AGENTPIER_SETUP_VERSION" in
  ''|*[!0-9A-Za-z.-]*) echo 'Installer version metadata is invalid.' >&2; exit 1;;
esac

[ "$(uname -s)" = Darwin ] || { echo 'AgentPier setup currently supports macOS only.' >&2; exit 1; }
SETUP_MACOS_VERSION=$(sw_vers -productVersion)
case "${SETUP_MACOS_VERSION%%.*}" in
  ''|*[!0-9]*|0|1[0-3]) echo 'AgentPier setup requires macOS 14 or newer.' >&2; exit 1;;
esac
[ "$(id -u)" != 0 ] || { echo 'Run AgentPier setup as a non-root user.' >&2; exit 1; }
case $(uname -m) in
  arm64) ;;
  x86_64)
    if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || printf 0)" = 1 ]; then
      echo 'Rosetta shells are unsupported. Run setup from a native terminal.' >&2
      exit 1
    fi
    ;;
  *) echo 'Unsupported macOS architecture.' >&2; exit 1;;
esac

if command -v brew >/dev/null 2>&1; then
  SETUP_BREW_PREFIX=$(brew --prefix 2>/dev/null || true)
  if [ -n "$SETUP_BREW_PREFIX" ]; then
    PATH="$SETUP_BREW_PREFIX/bin:$SETUP_BREW_PREFIX/sbin:$PATH"
  fi
fi
export PATH AGENTPIER_SETUP_VERSION
exec /bin/sh "$SCRIPT_DIR/install.sh" --setup "$@"
