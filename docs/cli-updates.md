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

The **Chrome for Testing** card is the agents' managed browser, not a CLI: **Update
browser** appears when AgentPier pins a newer build, and **Remove** deletes it (not
while the agent service uses it). An
installed managed browser is also updated in the background at the first server start
after an AgentPier update (see "Managed agent browser" in
[assistant-gateway.md](assistant-gateway.md)).

The agents' GitHub MCP server is managed the same way but has no card: AgentPier
installs its pinned release (checked by SHA-256) when an agent first gets GitHub
access, and an installed one follows a newer pinned version at the first server start
after an AgentPier update and on every installer run (see
[GitHub for agents](assistant-gateway.md#github-for-agents)).

UI updates are available for native installations in the server home and AgentPier-owned npm installations. Installations managed externally through Homebrew, npm or another package manager must be updated through that manager or migrated manually. GitHub CLI and the system shell are outside this update action.

## Minimum CLI versions

AgentPier starts sessions with a CLI it installed itself only when that CLI is at or above its minimum version:

| CLI         | Minimum   | Oldest release AgentPier was verified with                                                                                                                                                 |
| ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex       | `0.153.4` | Native model menus ([verification](research/verification.md)), live provider sessions with Chat binding ([live checks](research/live-provider-verification.md)) and `codex update` (above) |
| Claude Code | `2.1.263` | Native model menus, live provider sessions in Terminal and Chat, and the provider launch contract ([provider compatibility](research/provider-compatibility.md))                           |
| OpenCode    | `1.18.29` | Native model menus and live provider sessions with Chat binding                                                                                                                            |

These are the oldest releases with which the launch flags, history parsers and model menus were verified. Older releases are not known to be broken, but they were never exercised. A prerelease of a minimum (for example `2.1.263-beta.1`) counts as that version. The custom-endpoint protocol adapter was verified only on newer releases (Claude Code 2.1.291, Codex 0.159.2 and OpenCode 1.18.33, see [protocol adapter facts](research/protocol-adapter-facts.md)); the minimum does not guarantee that it works on older ones. The older Claude Code requirements for custom model contexts (2.1.193) and custom endpoint auth headers (2.1.227, see [providers](providers.md)) lie below this minimum; their checks and messages remain. The minimums live in one table in `server/features/tools/cli-version.js`.

AgentPier reads each version with `<cli> --version` in the background and keeps the result, including a failed read, until the executable's resolved path, modification time or size changes. An update or a replaced symlink is noticed without a restart, and a broken `--version` is not run on every refresh. The overview and the update dialog never wait for a read: until the first one finishes, a CLI shows no version. Version managers that run the CLI through a shim (asdf, mise, Volta) keep the shim file unchanged when they switch versions, so AgentPier may show the previous version until the server restarts. The dashboard shows the version on each coding tool and marks a CLI below its minimum with **Update required**; the update dialog shows the installed version and the minimum.

**Installations AgentPier manages.** For a native installation in the server user's home or an npm installation made by AgentPier, starting, logging in or reloading a session below the minimum is refused with the problem code `CLI_UPDATE_REQUIRED` and the detail `updateRequired: { tool, found, required }`. The **New session** dialog then shows a button named after the CLI, such as **Update Claude Code**, which opens the update dialog described above. After the update, start the session again. A reload that waited for the session to become idle and is then refused keeps this message instead of the generic reload failure.

**Other installations.** AgentPier cannot update a CLI installed through Homebrew, npm, another package manager or a manual download, so such a CLI below its minimum is not blocked. The **New session** dialog warns and asks you to update it with the package manager that installed it.

If the version cannot be read (no `--version` output, a timeout or an unknown format), the dialog shows a warning and the session starts anyway. One exception: Claude Code with a custom model or endpoint needs a verified version for its context configuration. AgentPier then reads the version once more with a longer timeout and, if that also fails, refuses the launch with "The Claude Code version could not be verified". Each new or reloaded session records the CLI version it started with as `cliVersion` in its session record.
