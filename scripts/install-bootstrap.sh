#!/bin/sh
validate_installer_options() {
  INSTALLER_SKIP=0 INSTALLER_EXPLICIT=0 INSTALLER_ONLY=0 INSTALLER_RELEASE=0
  INSTALLER_ROOT= INSTALLER_DATA=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --skip-dependencies) INSTALLER_SKIP=1;;
      --install-dependencies) INSTALLER_EXPLICIT=1;;
      --dependencies-only) INSTALLER_ONLY=1;;
      --service) INSTALLER_RELEASE=1;;
      --archive|--install-root|--data-dir|--channel)
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
      command -v brew >/dev/null 2>&1 || { echo 'Install Homebrew (https://brew.sh), then retry.' >&2; return 1; }
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
