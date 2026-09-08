# Shared CLI extensions

AgentPier accounts select credentials. Accounts for the same coding CLI share MCP definitions, plugins, marketplaces, skills and custom agents by default. Shell sessions are unaffected. The UI selects a CLI on **MCP & Skills** and **Plugins & Marketplace**; existing account-specific links normalize to the corresponding CLI.

## Native configuration

| CLI         | Shared native files and directories                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `~/.codex/config.toml`: `mcp_servers`, `plugins`, `marketplaces`, `skills`, `agents`; `~/.codex/{skills,agents,commands,plugins,.tmp/marketplaces}`                                       |
| Claude Code | `~/.claude.json`: `mcpServers`; `~/.claude/settings.json`: `enabledPlugins`, `extraKnownMarketplaces`; `~/.claude/{skills,agents,commands,plugins}`                                       |
| OpenCode    | `~/.config/opencode/{config.json,opencode.json,opencode.jsonc}`: `mcp`, `plugin`, `agent`; `tui.json`/`tui.jsonc`: `plugin`; `~/.config/opencode/{skills,agents,commands,plugins,plugin}` |

The server user's native profile is authoritative. Managed accounts keep their separate credential, provider and history locations. At work-session launch AgentPier copies only the listed fields into each account's mixed configuration files and links the asset directories. OAuth/account metadata, main model, provider keys and permission settings are preserved. Existing project configuration continues to follow native CLI precedence. Existing shared user skills under `~/.agents/skills` remain discoverable; new Codex installations use `~/.codex/skills`.

This is configuration sharing, not an OS security boundary. Native plugins and agents still execute with the session user's permissions. Plugin-specific account preferences and state inside shared plugin directories are shared with that plugin; CLI login credentials remain separate.

## Migration and subsequent edits

The first work-session launch, extension mutation or **Vorhandene Kontokonfigurationen übernehmen** imports existing managed extensions, including provider connection profiles. Merely viewing the page does not change native files. Different named entries merge; a conflicting shared entry wins as a complete definition. Existing skill packages are preserved as whole directories and are never mixed with another implementation. The UI reports conflicts without exposing configuration values. Imported files survive deletion of their former account.

Before the managed configuration is projected, original mixed files receive private `.before-sharing` copies. Existing asset directories are renamed to `.before-sharing-<uuid>` before linking. Import limits are 30,000 entries and 512 MiB; configuration files are bounded separately. Linked native destinations are treated as read-only and rejected for mutation. Resolve such a conflict in the native profile before retrying.

Native CLI changes to shared configuration fields are reconciled at the next launch, import or extension mutation. A per-entry hash baseline distinguishes new edits from stale account copies, so removing an MCP does not resurrect it when another account starts. Concurrent conflicts retain the shared version and are reported. Synchronization metadata contains hashes rather than copies of MCP secret values. Files in linked asset directories are shared immediately; native processes determine when they reload those files. Already running sessions are not restarted or reconfigured by AgentPier.

`shared-cli-profiles.json` records migration and reconciliation state. Do not delete it to resolve a conflict: that can import old account definitions again. Restore original configuration only with the affected native sessions stopped, and retain a backup of the shared profile first.

## Agency Agents

The catalog uses only the public [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) repository. Opening its section fetches a bounded GitHub tree pinned to a commit SHA. Search, category filtering and pagination show 20 entries per page. A one-hour cache supports ordinary viewing; a failed refresh reports an error, while an older cached catalog can be used when offline.

Preview and installation fetch Markdown from the selected immutable revision. A changed catalog requires a new preview. Only validated YAML identity/description and the instruction body are converted. The installer does not execute upstream scripts, clone the repository, bulk-install the catalog, or accept arbitrary download hosts. Installation is always an explicit selection in the UI.

- Claude: native agent Markdown, `model: inherit`.
- Codex: native agent TOML with `name`, `description`, `developer_instructions`.
- OpenCode: native agent Markdown with `mode: subagent`.

Upstream model and tool/permission overrides are not imported. Source URL, revision and MIT license attribution are retained alongside the installed agent. `agency-agents.json` tracks installation ownership. Removal checks the original path, inode and content hash; externally modified files remain intact. Native CLI custom-agent support is required; the agent files supply instructions, not a separate model runtime.

## Backups and verification

Logical AgentPier backups exclude external native CLI profiles, including shared extensions and Agency installation ownership records. Encrypted managed-profile backups omit only verified shared directory links; unexpected links remain an error. Use a filesystem backup of the native CLI roots plus `shared-cli-profiles.json`, `agency-agents.json` and `extension-skills.json` when moving the complete installation. A restored account can inherit the destination machine's shared profile on its next start.

Integration tests exercise all three CLIs, credential/model preservation, migration conflicts, ownership boundaries, provider profiles, deletion, restart and encrypted backups. Generated properties cover concurrent edits and removal reconciliation. HTTP tests pin the Agency revision and protect modified files. Desktop/mobile browser tests cover CLI selection, search, preview, install/remove and deep links. Native smoke tests use disposable homes; they do not install tools globally or make model calls.
