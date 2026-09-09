# CLI installation and updates

AgentPier installs Codex, Claude Code and OpenCode through their official native installation scripts. On the dashboard, choose **Update CLI** on an installed coding tool, then **Update now**. The dialog shows the command and progress; closing it does not cancel the operation. Only one installation or update runs at a time.

| CLI         | Manual update command            | Native installer                                        |
| ----------- | -------------------------------- | ------------------------------------------------------- |
| Codex       | `codex update`                   | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` |
| Claude Code | `claude update`                  | `curl -fsSL https://claude.ai/install.sh \| bash`       |
| OpenCode    | `opencode upgrade --method curl` | `curl -fsSL https://opencode.ai/install \| bash`        |

Codex's `update` subcommand is verified in CLI 0.153.4 (`codex update --help`). The [Codex installation guide](https://learn.chatgpt.com/docs/codex/cli) also documents rerunning its standalone installer. See the official [Claude Code update guide](https://code.claude.com/docs/en/setup) and [OpenCode upgrade reference](https://opencode.ai/docs/cli/#upgrade).

Updates run with the AgentPier server user's home, using the native executable rather than an account-specific profile. Account credentials and conversations are preserved. Existing sessions keep running; use [Reload & resume](session-reload.md) when you want an existing session to use the new version. An AgentPier application release is separate from a CLI update.

For older npm installations managed by AgentPier, the action is **Migrate & update**. AgentPier runs the official installer, checks the resulting version, then switches its owned activation link to the native CLI. A failed installation leaves the old activation in place. Old npm package directories remain available to running processes and are not automatically deleted. No global npm uninstall or removal of account profiles is performed.

UI updates are available for native installations in the server home and AgentPier-owned npm installations. Installations managed externally through Homebrew, npm or another package manager must be updated through that manager or migrated manually. GitHub CLI and the system shell are outside this update action.
