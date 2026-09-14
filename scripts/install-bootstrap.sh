#!/bin/sh
validate_installer_options() {
  INSTALLER_SKIP=0 INSTALLER_EXPLICIT=0 INSTALLER_ONLY=0 INSTALLER_RELEASE=0
  INSTALLER_ROOT= INSTALLER_DATA=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --skip-dependencies) INSTALLER_SKIP=1;;
      --install-dependencies) INSTALLER_EXPLICIT=1;;
      --dependencies-only) INSTALLER_ONLY=1;;
      --service|--resume) INSTALLER_RELEASE=1;;
      --archive|--install-root|--data-dir|--channel|--initial-channel)
        [ "$#" -gt 1 ] && [ -n "$2" ] || { echo 'Missing installer option value.' >&2; return 1; }
        case "$2" in --*) echo 'Missing installer option value.' >&2; return 1;; esac
        case "$1" in --install-root) INSTALLER_ROOT=$2;; --data-dir) INSTALLER_DATA=$2;; esac
        INSTALLER_RELEASE=1
        shift
        ;;
      *) echo 'Invalid installer option.' >&2; return 1;;
    esac
    shift
  done
  if [ "$INSTALLER_SKIP" = 1 ] && { [ "$INSTALLER_EXPLICIT" = 1 ] || [ "$INSTALLER_ONLY" = 1 ]; }; then
    echo '--skip-dependencies cannot be combined with dependency installation options.' >&2
    return 1
  fi
  if [ "$INSTALLER_ONLY" = 1 ]; then
    [ "$INSTALLER_RELEASE" = 0 ] || { echo '--dependencies-only cannot be combined with release or service options.' >&2; return 1; }
  else
    case "$INSTALLER_ROOT" in /*) ;; *) echo 'Absolute --install-root and --data-dir paths are required.' >&2; return 1;; esac
    case "$INSTALLER_DATA" in /*) ;; *) echo 'Absolute --install-root and --data-dir paths are required.' >&2; return 1;; esac
  fi
}

validate_setup_options() {
  SETUP_ONLY=0 SETUP_OTHER=0
  SETUP_ROOT=${AGENTPIER_INSTALL_ROOT:-"${HOME:-}/.local/share/agentpier-app"}
  SETUP_DATA=${AGENTPIER_DATA_DIR:-"${HOME:-}/Library/Application Support/AgentPier"}
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-service|--skip-dependencies)
        SETUP_OTHER=1
        ;;
      --dependencies-only)
        SETUP_ONLY=1
        ;;
      --install-root|--data-dir)
        [ "$#" -gt 1 ] && [ -n "$2" ] || {
          echo "$1 requires a value." >&2
          return 1
        }
        case "$2" in --*) echo "$1 requires a value." >&2; return 1;; esac
        if [ "$1" = --install-root ]; then SETUP_ROOT=$2; else SETUP_DATA=$2; fi
        SETUP_OTHER=1
        shift
        ;;
      *) echo "Unknown setup option: $1" >&2; return 1;;
    esac
    shift
  done
  if [ "$SETUP_ONLY" = 1 ] && [ "$SETUP_OTHER" = 1 ]; then
    echo '--dependencies-only cannot be combined with other setup options.' >&2
    return 1
  fi
  [ "$SETUP_ONLY" = 1 ] && return 0
  case "$SETUP_ROOT" in /*) ;; *) echo 'Setup paths must be absolute.' >&2; return 1;; esac
  case "$SETUP_DATA" in /*) ;; *) echo 'Setup paths must be absolute.' >&2; return 1;; esac
  for SETUP_PATH in "$SETUP_ROOT" "$SETUP_DATA"; do
    case "$SETUP_PATH" in
      /|*[!/]) ;;
      *) echo 'Setup requires normalized absolute paths without dot segments.' >&2; return 1;;
    esac
    case "$SETUP_PATH/" in
      *'/./'*|*'/../'*|*'//'*) echo 'Setup requires normalized absolute paths without dot segments.' >&2; return 1;;
    esac
  done
  case "$SETUP_DATA/" in
    "$SETUP_ROOT/"*) echo 'The data directory must be outside the install root.' >&2; return 1;;
  esac
}

# Used only when the installer must download its temporary Node runtime.
ensure_bootstrap_tools() {
  BOOTSTRAP_PACKAGES=
  command -v curl >/dev/null 2>&1 || BOOTSTRAP_PACKAGES="$BOOTSTRAP_PACKAGES curl"
  command -v tar >/dev/null 2>&1 || BOOTSTRAP_PACKAGES="$BOOTSTRAP_PACKAGES tar"
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    BOOTSTRAP_PACKAGES="$BOOTSTRAP_PACKAGES coreutils"
  fi
  [ -n "$BOOTSTRAP_PACKAGES" ] || return 0
  for BOOTSTRAP_OPTION in "$@"; do
    if [ "$BOOTSTRAP_OPTION" = '--skip-dependencies' ]; then
      echo "Missing Node bootstrap packages:$BOOTSTRAP_PACKAGES. Install them or omit --skip-dependencies." >&2
      return 1
    fi
  done
  echo "Installing Node bootstrap packages:$BOOTSTRAP_PACKAGES" >&2
  case "$PLATFORM" in
    darwin)
      /bin/sh "$SCRIPT_DIR/install-homebrew.sh" || return 1
      # Package names above are fixed, trusted tokens, intentionally split here.
      brew install $BOOTSTRAP_PACKAGES || return 1
      ;;
    linux)
      command -v apt-get >/dev/null 2>&1 || { echo "Install$BOOTSTRAP_PACKAGES with your package manager, then retry." >&2; return 1; }
      if [ "$(id -u)" = 0 ]; then
        apt-get update && apt-get install -y $BOOTSTRAP_PACKAGES || return 1
      elif [ -t 0 ]; then
        sudo apt-get update && sudo apt-get install -y $BOOTSTRAP_PACKAGES || return 1
      else
        sudo -n apt-get update && sudo -n apt-get install -y $BOOTSTRAP_PACKAGES || return 1
      fi
      ;;
  esac
  command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1 &&
    { command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1; } || {
      echo 'Node bootstrap tools are still unavailable. Check installation and PATH.' >&2
      return 1
    }
}
