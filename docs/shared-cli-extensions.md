# Shared CLI extensions

AgentPier accounts select credentials. Accounts for the same coding CLI share MCP definitions, local plugins, configured marketplaces, skills and custom agents by default. Codex default marketplace plugins remain account-specific. Shell sessions are unaffected. The UI selects a CLI profile under **CLIs and extensions › Extensions** (sidebar **Menu**, group **Set up**; `/coding/clis/extensions/<profile>`), whose tabs cover **Skills**, **Plugins**, **Marketplaces** and **Subagents** (a reference row links to the central MCP list); existing account-specific links, the former `/extensions` and plugin page links and `?tab=agents` normalize to the corresponding CLI and tab. See the [CLIs and extensions page](screenshots/coding-clis-desktop.png) ([on a phone](screenshots/coding-clis-phone.png)).

## Native configuration

| CLI         | Shared native files and directories                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `~/.codex/config.toml`: `mcp_servers`, `plugins`, `marketplaces`, `skills`, `agents`; `~/.codex/{skills,agents,commands,plugins,.tmp/marketplaces}`                                       |
| Claude Code | `~/.claude.json`: `mcpServers`; `~/.claude/settings.json`: `enabledPlugins`, `extraKnownMarketplaces`; `~/.claude/{skills,agents,commands,plugins}`                                       |
| OpenCode    | `~/.config/opencode/{config.json,opencode.json,opencode.jsonc}`: `mcp`, `plugin`, `agent`; `tui.json`/`tui.jsonc`: `plugin`; `~/.config/opencode/{skills,agents,commands,plugins,plugin}` |

The server user's native profile is authoritative. Managed accounts keep their separate credential, provider and history locations. At work-session launch AgentPier copies only the listed fields into each account's mixed configuration files and links the asset directories. OAuth/account metadata, main model, provider keys and permission settings are preserved. Existing project configuration continues to follow native CLI precedence. Existing shared user skills under `~/.agents/skills` remain discoverable; new Codex installations use `~/.codex/skills`.

MCP servers are managed centrally under **Connections › MCP servers** ([mcp.md](mcp.md#central-mcp-servers-in-the-coding-clis)); **Extensions** only shows a reference row that links there; old `?tab=mcp` links open Skills. AgentPier writes servers bound to a CLI into that CLI's canonical native profile before each launch, ahead of the projection described below, so a managed account receives them in the same launch. Entries added natively are still shared and are offered for adoption in the central list.

This is configuration sharing, not an OS security boundary. Native plugins and agents still execute with the session user's permissions. Plugin-specific account preferences and state inside shared plugin directories are shared with that plugin; CLI login credentials remain separate.

## Codex default marketplace

Codex provides `openai-curated-remote` through its authenticated native catalog;
it may be absent from `codex plugin marketplace list`. AgentPier shows it as a
built-in marketplace, with no source update or removal controls. Choose a logged-in
Codex account in **Marketplace account** to browse and install its available plugins.
An unauthenticated local profile can show an empty catalog even while another
account has access. AgentPier does not select another account or copy credentials
automatically.

Remote installation, removal, and installed state belong to the explicitly selected
account. Shared-profile synchronization preserves each account's remote plugin
configuration without importing or projecting it into other profiles. Local plugin
and marketplace operations retain their shared scope. Plugin cache directories
remain shared; this is configuration isolation, not an OS security boundary.

The change ships in ordinary release packages and needs no additional runtime
installation. Reload or start a session to load changed native plugin configuration.

## Installing skills

**Extensions › Skills › Install skill** installs one skill into the selected CLI
profile's `skills` directory (shown as **Destination directory**), from an uploaded
`SKILL.md` or ZIP, or from a public GitHub link. **Check skill** first reads and scans
the source without writing anything (see [Skill import scan](#skill-import-scan));
**Install skill** in the scan result then writes exactly the checked files. Existing
directories are never overwritten and no script of the skill runs during installation. A GitHub folder link
(`https://github.com/<owner>/<repo>/tree/<ref>/<folder>`) may name a branch, a tag or a
full 40-character commit SHA as `<ref>`. AgentPier resolves a branch or tag through the
public GitHub API (an annotated tag to the commit it tags), refuses a name that is both
a branch and a tag (use the commit SHA then), downloads exactly the resolved commit and
records it: the skill's row names the repository, the ref and the commit, for example
"GitHub owner/repo · tag v1.2.0 · commit 0123456789ab". Repository and ZIP links
without a `tree/<ref>` part download as before and record no commit. A skill does not
follow later commits of a branch; install it again to update it. GitHub limits these
unauthenticated lookups per address (60 an hour); a limited lookup says so, and a
commit SHA needs no lookup. GitHub serves a commit SHA from the whole fork network of
a repository, so a `tree/<sha>` link can name a commit that only exists in a fork;
take SHAs from the repository's own history or releases.

### Skill import scan

Every ZIP, `SKILL.md` and GitHub import is scanned offline before anything is written.
The scan (`server/features/extensions/skill-scan.js`) reads the unpacked files only: it
runs nothing, fetches nothing and decodes nothing it finds. The result lists the verdict
and the findings grouped by file, each with its rule, line and a short excerpt in which
hidden characters are shown as code points such as `<U+202E>`.

| Rule                                        | Finds                                                                                                                                                                                                                                                                                                                                                       | Severity                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Downloads code and runs it                  | a download piped into a shell or interpreter (`curl … \| sh`, `wget … \| bash`, `bash -c "$(curl …)"`, `sh <(curl …)`, `iex (iwr …)`, `irm … \| iex`), a download made executable or started (`&& chmod +x`), `exec`/`eval` of a fetched URL; lines continued with `\` count as one                                                                         | block in `SKILL.md`, the documents it links or names and every non-document file (scripts, code); warn in other documents such as `README.md` |
| Reads credentials and sends data            | a credential path (`~/.ssh`, `id_rsa`/`id_ed25519`, `~/.aws/credentials`, `.env`, `.netrc`, `.git-credentials`, Docker or kube config, `gh` hosts, the keychain, `/etc/shadow`) and a network call (`curl`, `wget`, `nc`, `scp`, `fetch(`, `requests.post(`, `Invoke-WebRequest`, `/dev/tcp` …) in the same file; in Markdown within 20 lines of each other | block                                                                                                                                         |
| Invisible text direction controls           | U+202A–U+202E and U+2066–U+2069                                                                                                                                                                                                                                                                                                                             | block in instruction text, warn elsewhere                                                                                                     |
| Invisible Unicode tag characters            | U+E0000–U+E007F outside a flag emoji sequence                                                                                                                                                                                                                                                                                                               | block in instruction text, warn elsewhere                                                                                                     |
| Invisible characters                        | zero-width space, word joiner and invisible operators, a byte order mark after the start of a file, zero-width (non-)joiners outside emoji sequences and scripts that need them, runs of variation selectors                                                                                                                                                | block in instruction text, warn elsewhere                                                                                                     |
| Phrasing that tries to replace instructions | English and German prompt-injection phrasing in instruction text ("ignore all previous instructions", "do not tell the user", "without asking the user", `<system>` tags, `--dangerously-skip-permissions` …)                                                                                                                                               | warn                                                                                                                                          |
| Long encoded data block                     | 200 or more contiguous base64 characters (mixed case and digits) or hex characters (digits and letters), or 50 `\xNN` escapes                                                                                                                                                                                                                               | warn                                                                                                                                          |
| Executable file                             | a file with an execute bit; the bit is kept on install                                                                                                                                                                                                                                                                                                      | warn                                                                                                                                          |
| Executable program (binary)                 | ELF, Mach-O, PE or WebAssembly headers                                                                                                                                                                                                                                                                                                                      | warn                                                                                                                                          |

Instruction text is every `.md`, `.mdx`, `.markdown` and `.txt` file, including
`SKILL.md`. A hidden character in a file name is a warning. Code that merely mentions
`curl` or `wget` without piping into a shell, flag and multi-person emoji, and the
joiners of Indic, Arabic or Persian text are not findings. At most 5 findings per rule
and file and 200 in total are listed; the verdict still counts every match.

- **No findings**: **Install skill** installs the skill.
- **Warnings**: **Install skill** stays disabled until the owner ticks "I have reviewed
  the warnings and want to install the skill."
- **Blocked**: there is no normal install. **Install anyway …** opens a second
  confirmation that names every blocking rule; **Accept the risk and install** installs
  the skill as an override.

A preview is used once, expires after 10 minutes and is bound to its profile and the
SHA-256 hash of the checked files; the server keeps the checked files, so a changed
upload or a GitHub branch that moved later cannot be installed with an older preview.
Check the source again after an expiry. The audit log records each check as
`extension.inspected` and the decision as `extension.installed` or, for a blocked skill,
`extension.overridden`, with the verdict, the import kind (`zip`, `skill-md` or
`github`), the rules that matched and the number of findings; never paths, excerpts or
content. Skills already installed are not scanned again, and skills bundled with an MCP
package and plugin installs are not scanned yet; `scanSkill(files)` takes the unpacked
`[path, data, mode]` entries of any source for that.

Skills bundled with an MCP server package are offered in the package's panel; see
[Bundled skills of a package](mcp.md#bundled-skills-of-a-package). Their rows on
**Extensions › Skills** say "From MCP package <name>@<version> · updated and removed
with it".

## Bundled skills

AgentPier ships `agentpier-composer` from `server/features/cli-profiles/skills/`.
The first work-session launch for each CLI installs it into that CLI's shared native
`skills` directory from the table above. Managed accounts inherit it through the
existing asset links. Login and shell sessions do not install skills; already running
sessions are not reloaded. The same `SKILL.md` is used by Codex, Claude Code and OpenCode.
Composer is opt-in: explicitly invoke it or request its orchestration workflow.
Ordinary ticket planning, implementation, CI/merge requests, and discussion or editing
of the skill do not activate it. Codex receives `agents/openai.yaml` with
`allow_implicit_invocation: false`; Claude Code uses `disable-model-invocation: true`.
The shared description and activation section express the same boundary for other
hosts, including OpenCode. Existing user-owned packages remain untouched; update
the installed skill explicitly when adopting this policy for an existing profile.

The composer identifies each ticket's system, instance and project from the task and
verifies the ticket through an available integration, CLI or API. It does not assume
Plane or infer the ticket system solely from the Git remote. Ticket-system access and
a suitable AgentPier pipeline are configured separately.

For an authorized implementation, the composer monitors each PR through confirmed
merge, including after CI turns green or auto-merge is enabled. It then refreshes
the base and starts the next authorized batch across the remaining topics without
another prompt. Status reports and merge recommendations are intermediate updates.
Batch progress, PR polling and merge evidence are retained for resumption even when
no pipeline is active. Merging requires existing authorization and repository checks;
otherwise the composer continues monitoring for an external merge. Explicitly scoped
planning or review tasks retain their requested endpoint.

Existing packages with the same name are preserved, including skills imported from
managed accounts. Installation is recorded per native profile in
`bundled-skills.json` in the AgentPier data directory. Later launches and releases
neither overwrite edits nor reinstall deleted packages. To adopt a newer bundled
version, explicitly replace the native package from the checked-in source (or upload
its `SKILL.md` through skill management after removing the old package). Back up native
skill directories and the installation record to preserve these choices when moving
the installation.

## Migration and subsequent edits

The first work-session launch, extension mutation or **Vorhandene Account-Konfigurationen übernehmen** imports existing managed extensions, including provider connection profiles. Merely viewing the page does not change native files. Different named entries merge; a conflicting shared entry wins as a complete definition. Existing skill packages are preserved as whole directories and are never mixed with another implementation. The UI reports conflicts without exposing configuration values. Imported files survive deletion of their former account.

Before the managed configuration is projected, original mixed files receive private `.before-sharing` copies. Existing asset directories are renamed to `.before-sharing-<uuid>` before linking. Import limits are 30,000 entries and 512 MiB; configuration files are bounded separately. Linked native destinations are treated as read-only and rejected for mutation. Resolve such a conflict in the native profile before retrying.

Native CLI changes to shared configuration fields are reconciled at the next launch, import or extension mutation. A per-entry hash baseline distinguishes new edits from stale account copies, so removing an MCP does not resurrect it when another account starts. Concurrent conflicts retain the shared version and are reported. Synchronization metadata contains hashes rather than copies of MCP secret values. Files in linked asset directories are shared immediately; native processes determine when they reload those files. Already running sessions are not restarted or reconfigured by AgentPier. AgentPier's own MCP writes go only to the canonical profile, so they never appear as drift of an account.

`shared-cli-profiles.json` records migration and reconciliation state. Do not delete it to resolve a conflict: that can import old account definitions again. Restore original configuration only with the affected native sessions stopped, and retain a backup of the shared profile first.

## Agency Agents

Installed Agency agents are CLI subagents: **CLIs and extensions › Extensions ›
Subagents** (formerly **Extensions › Agents**) installs and removes them per CLI
profile. The same catalog is under **Agents › Templates**, where a preview offers
**Install as subagent in a CLI …** (choose the CLI under **Install for**) and shows in
how many CLIs the entry is already installed.

The catalog uses only the public [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) repository. Opening its section fetches a bounded GitHub tree pinned to a commit SHA. Search, category filtering and pagination show 20 entries per page. A one-hour cache supports ordinary viewing; a failed refresh reports an error, while an older cached catalog can be used when offline. After a failure, reads use the cached catalog (or report the failure) for five minutes without asking GitHub again; **Refresh catalog** always asks.

Preview and installation fetch Markdown from the selected immutable revision. A changed catalog requires a new preview. Only validated YAML identity/description and the instruction body are converted. The installer does not execute upstream scripts, clone the repository, bulk-install the catalog, or accept arbitrary download hosts. Installation is always an explicit selection in the UI.

- Claude: native agent Markdown, `model: inherit`.
- Codex: native agent TOML with `name`, `description`, `developer_instructions`.
- OpenCode: native agent Markdown with `mode: subagent`.

Upstream model and tool/permission overrides are not imported. Source URL, revision and MIT license attribution are retained alongside the installed agent. `agency-agents.json` tracks installation ownership. Removal checks the original path, inode and content hash; externally modified files remain intact. Native CLI custom-agent support is required; the agent files supply instructions, not a separate model runtime.

### Agency agents as AgentPier agent templates

While agents are switched on, an entry's preview (under **Subagents** or **Agents ›
Templates**) also offers **Create personal agent**. It opens the new agent wizard with
the entry as its template; **From template** in the wizard's first step searches the
same catalog. AgentPier fetches the entry at the pinned revision
(`GET /api/agency/templates` and `/api/agency/templates/preview`,
`server/features/agency/agency-templates.js`) and fills **Name** and **Instructions**:
the description, the instruction body and a closing attribution with the source URL,
the revision and the MIT license. The upstream `model`, `tools` and permission fields
are never read; tools and access start with the agent form's defaults (no shell, SSH,
project folders or GitHub). The profile keeps the template's id, name, revision and
source, shown on its **Identity** tab. **Remove template** restores the name and instructions from before the template. The template is fetched before the agent is admitted, so a slow GitHub never holds other agent operations.

Catalog text is untrusted. Each entry is scanned offline with the skill import scan
(`skill-scan.js`): a blocked entry (hidden characters, download-and-run, credential
exfiltration) cannot be used, and the server refuses it again when the agent is
created; warnings such as instruction-override phrasing are shown with their lines.
Composed instructions longer than 48,000 characters are refused.

Leads can use the same entries for team members: see [agents](agents.md#teams-asks-and-tasks).

## Backups and verification

Logical AgentPier backups exclude external native CLI profiles, including shared extensions and Agency installation ownership records. Encrypted managed-profile backups omit only verified shared directory links; unexpected links remain an error. Use a filesystem backup of the native CLI roots plus `shared-cli-profiles.json`, `agency-agents.json` and `extension-skills.json` when moving the complete installation. A restored account can inherit the destination machine's shared profile on its next start.

Integration tests exercise all three CLIs, credential/model preservation, migration conflicts, ownership boundaries, provider profiles, deletion, restart and encrypted backups. Generated properties cover concurrent edits and removal reconciliation. HTTP tests pin the Agency revision and protect modified files. Desktop/mobile browser tests cover CLI selection, search, preview, install/remove and deep links. Native smoke tests use disposable homes; they do not install tools globally or make model calls.
