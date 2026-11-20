# CLI installation and updates

AgentPier installs Codex, Claude Code and OpenCode through their official native installation scripts. Under **CLIs & extensions › Installation**, choose **Update CLI** on an installed coding tool, then **Update now**. On the start page, **Your tools** offers the same as **Update** on a CLI below its minimum version, and otherwise as **Update CLI** in the tool's ⋯ menu. The dialog shows the command and progress; closing it does not cancel the operation. Only one installation or update runs at a time.

| CLI         | Manual update command            | Native installer                                        |
| ----------- | -------------------------------- | ------------------------------------------------------- |
| Codex       | `codex update`                   | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` |
| Claude Code | `claude update`                  | `curl -fsSL https://claude.ai/install.sh \| bash`       |
| OpenCode    | `opencode upgrade --method curl` | `curl -fsSL https://opencode.ai/install \| bash`        |

The update arguments and installer scripts come from each CLI's definition (`updateArgs`, `nativeInstaller`) in `server/features/clis/<id>/definition.js`; see [coding CLIs](coding-clis.md).

Codex's `update` subcommand is verified in CLI 0.169.1 (`codex update --help`). The [Codex installation guide](https://learn.chatgpt.com/docs/codex/cli) also documents rerunning its standalone installer. See the official [Claude Code update guide](https://code.claude.com/docs/en/setup) and [OpenCode upgrade reference](https://opencode.ai/docs/cli/#upgrade).

Updates run with the AgentPier server user's home, using the native executable rather than an account-specific profile. Account credentials and conversations are preserved. Existing sessions keep running; use [Reload & resume](session-reload.md) when you want an existing session to use the new version. An AgentPier application release is separate from a CLI update.

For older npm installations managed by AgentPier, the action is **Migrate & update**. AgentPier runs the official installer, checks the resulting version, then switches its owned activation link to the native CLI. A failed installation leaves the old activation in place. Old npm package directories remain available to running processes and are not automatically deleted. No global npm uninstall or removal of account profiles is performed.

The **Chrome for Testing** card is the agents' managed browser, not a CLI: **Update
browser** appears when AgentPier pins a newer build, and **Remove** deletes it (not
while the agent service uses it). An
installed managed browser is also updated in the background at the first server start
after an AgentPier update (see "Managed agent browser" in
[assistant-gateway.md](assistant-gateway.md)).

The **REA** card is a managed MCP server with its analysis tools, not a CLI either: its
dialog shows **Update** when AgentPier pins a newer REA Core, Ghidra, JDK or Frida, and
an installed REA follows the new pins at the first server start after an AgentPier
update, unless a session or an agent uses it at that moment; then the next start tries
again (see [managed REA](mcp.md#managed-rea)).

The **Craft Anything** card works the same way: its dialog shows **Update** when
AgentPier pins a newer Craft Anything, Ghidra or JDK, and an installed Craft Anything
follows at the first server start after an AgentPier update unless a session or an agent
uses it (see [managed Craft Anything](mcp.md#managed-craft-anything)).

The agents' GitHub MCP server is managed the same way but has no card: AgentPier
installs its pinned release (checked by SHA-256) when an agent first gets GitHub
access, and an installed one follows a newer pinned version at the first server start
after an AgentPier update and on every installer run (see
[GitHub for agents](assistant-gateway.md#github-for-agents)).

UI updates are available for native installations in the server home and AgentPier-owned npm installations. Installations managed externally through Homebrew, npm or another package manager must be updated through that manager or migrated manually. GitHub CLI and the system shell are outside this update action.

## Minimum CLI versions

AgentPier starts sessions with a CLI it installed itself only when that CLI is at or above its minimum version:

| CLI         | Minimum   | Verified with                                                                                                                                                                                                           |
| ----------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `0.169.1` | `/model` and effort pickers with short key hints and the idle composer footer (captures in `tests/fixtures/models`), MCP entries and the brokered MCP login ([qualification](cli-mcp-qualification.md)), `codex update` |
| Claude Code | `2.1.329` | Redrawn `/model` picker with **More models**, onboarding theme dialog, activity hooks and plan approval (`AGENTPIER_CLI_HOOK_CONTRACT=1`), MCP entries and login ([qualification](cli-mcp-qualification.md))            |
| OpenCode    | `1.19.6`  | MCP entries and login ([qualification](cli-mcp-qualification.md))                                                                                                                                                       |

AgentPier supports each CLI from its minimum to the current release, covered by the real-CLI contract tests (for example `AGENTPIER_CLI_HOOK_CONTRACT=1` for Claude Code's hooks). A change that adapts AgentPier to a new CLI release raises that CLI's minimum to the release it was verified with and removes the handling of older layouts in the same change; the minimums are reviewed at every AgentPier release. Releases below a minimum are not known to be broken, but AgentPier no longer reads their older screens and hooks. A prerelease of a minimum (for example `2.1.329-beta.1`) counts as that version.

Within that range, features that once needed a newer Claude Code depend only on a version AgentPier could read: custom model contexts and custom endpoint auth headers (see [providers](providers.md)), the `MessageDisplay` hook for live reply text and the `agentpier-bridge` mod for token-level reply text, tool status, turn activity and task stops (see [live chat updates](native-chat-delivery.md#live-chat-updates)). A Claude Code whose version is unknown starts without the hook and the mod and keeps the terminal reading. Each minimum is the `minVersion` field of the CLI's definition in `server/features/clis/<id>/definition.js`; `server/features/tools/cli-version.js` builds its table from them (see [coding CLIs](coding-clis.md)).

AgentPier reads each version with `<cli> --version` in the background and keeps the result, including a failed read, until the executable's resolved path, modification time or size changes. An update or a replaced symlink is noticed without a restart, and a broken `--version` is not run on every refresh. The overview and the update dialog never wait for a read: until the first one finishes, a CLI shows no version. Version managers that run the CLI through a shim (asdf, mise, Volta) keep the shim file unchanged when they switch versions, so AgentPier may show the previous version until the server restarts. The start page and **CLIs & extensions › Installation** show the version on each coding tool and mark a CLI below its minimum with **Update required**; the start page also lists it under **Needs you**, and the update dialog shows the installed version and the minimum.

**Installations AgentPier manages.** For a native installation in the server user's home or an npm installation made by AgentPier, starting, logging in or reloading a session below the minimum is refused with the problem code `CLI_UPDATE_REQUIRED` and the detail `updateRequired: { tool, found, required }`. The **New session** dialog then shows a button named after the CLI, such as **Update Claude Code**, which opens the update dialog described above. After the update, start the session again. A reload that waited for the session to become idle and is then refused keeps this message instead of the generic reload failure.

**Other installations.** AgentPier cannot update a CLI installed through Homebrew, npm, another package manager or a manual download, so such a CLI below its minimum is not blocked. The **New session** dialog warns and asks you to update it with the package manager that installed it.

**In the chat.** A running session whose recorded `cliVersion` is below its CLI's minimum shows a **CLI out of date** notice above the chat composer: "This Claude Code 2.1.300 is older than AgentPier supports (2.1.329). Some chat features may not work. Update it:", followed by the way to update that installation:

- an installation AgentPier manages: the **Update <CLI>** button, which opens the update dialog described above;
- Homebrew: the `brew upgrade` command for its cask or formula (for example `brew upgrade --cask claude-code`), with **Copy command**;
- npm: `npm install -g <package>@latest` for its global package (for example `npm install -g @openai/codex@latest`), with **Copy command**;
- anything else: a hint to update it with the package manager, installer or download it came from.

AgentPier reads the installation method from the executable's resolved path (`server/features/tools/cli-install-method.js`): a `Caskroom/<name>` or `Cellar/<name>` folder means Homebrew, a `node_modules/<package>` folder npm. The tool list carries it as `installMethod` and `updateCommand` for every installation AgentPier does not manage. A session whose version could not be read never shows the notice. The notice follows the live `state` topic, which reads the installed versions again after an update through AgentPier at once and otherwise within 60 seconds, so it disappears as soon as the installed CLI is at its minimum; the running session keeps its old CLI until you [reload it](session-reload.md). A session started or reloaded with a current CLI records that version and shows no notice.

If the version cannot be read (no `--version` output, a timeout or an unknown format), the dialog shows a warning and the session starts anyway. One exception: Claude Code with a custom model or endpoint needs a verified version for its context configuration. AgentPier then reads the version once more with a longer timeout and, if that also fails, refuses the launch with "The Claude Code version could not be verified". Each new or reloaded session records the CLI version it started with as `cliVersion` in its session record.
