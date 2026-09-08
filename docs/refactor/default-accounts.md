# Native account defaults and authentication

`preferences.json` stores `defaultAccountIds` by CLI (`codex`, `claude`, `opencode`). Partial updates merge; null removes an override. A default must reference an existing non-provider, non-internal account for that CLI. Deleted or invalid saved references fall back to the local CLI profile. The file is private, and no credential bytes are copied or returned in preferences.

New native sessions without explicit account IDs resolve the selected default. The launch dialog also selects it; explicit account choices and central provider connections retain precedence. Claude/OpenCode UI starts default to Auto. Codex remains Standard. Changing only the account preserves the chosen launch mode.

Claude account Sign in starts the normal native TUI in the managed profile. It remains a login-purpose session, so AgentBus and work hooks are not added. The account page calls a bounded `claude auth status --json` probe in that profile, cached for ten seconds and deduplicated while pending. Only authenticated/unauthenticated/unknown state and check time reach the browser. A missing command, malformed output or timeout never becomes a successful authentication claim. Provider/API-key accounts are excluded from native OAuth probing.
