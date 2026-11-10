#!/bin/sh
# AgentPier puts this file first on PATH, as `security`, for the Claude Code processes
# of a managed account (server/features/clis/claude/login-store.js). Claude Code keeps
# its login in the macOS keychain by running `security`; told that its item does not
# exist and cannot be stored, it keeps the login in `.credentials.json` in the account
# folder instead. Only Claude Code's own credential items are answered here. Every
# other call runs the real tool unchanged.
real=/usr/bin/security

not_found() {
  echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2
  exit 44
}

for argument in "$@"; do
  case $argument in
    "Claude Code-credentials"*) not_found ;;
  esac
done

# `security -i` reads its commands from standard input: Claude Code stores a login
# that way, so the secret never appears in a process list. A terminal is left alone.
if [ "${1-}" = "-i" ] && [ ! -t 0 ]; then
  commands=$(cat)
  case $commands in
    *"Claude Code-credentials"*) not_found ;;
  esac
  printf '%s\n' "$commands" | "$real" "$@"
  exit $?
fi

exec "$real" "$@"
