# Shared CLI extensions and Agency Agents

**Goal:** Accounts switch credentials while MCPs, plugins, marketplaces, skills and custom agents are shared by CLI by default.

**Architecture:** The existing local native configuration is the authoritative extension profile for each CLI. Management routes normalize account aliases to that CLI profile. Managed accounts retain credential/state directories; at work-session launch they receive only shared extension configuration fields and links to shared asset directories. Existing managed extensions are imported without overwriting conflicting shared definitions; originals are preserved. Source account deletion must not remove imported extensions. No entire config or auth file is shared.

**Constraints:** English source, German UI, <=600 lines per file, macOS/Linux, preserve active sessions and all credentials. All local tests use temporary homes. Do not run external Agency install scripts. User authorized implementation and deployment; no further design approval is required under the session instructions.

- [x] Shared profile resolver, non-destructive migration and selective runtime application. Tests cover same-CLI sharing, CLI separation, provider configuration/auth preservation, conflicts, symlink boundaries and restart/deletion.
- [x] Route/store integration with per-CLI plugin locks/cache; CLI-level management UI and old deep-link normalization. Verify current native config behavior against official docs and installed binaries in disposable homes.
- [x] Agency catalog for `msitarzewski/agency-agents`: fetch a pinned GitHub tree, search/category/page, preview raw Markdown at that commit, explicit selected-agent install/remove. Parse bounded YAML and emit native Claude/OpenCode Markdown and Codex TOML, inheriting the selected model and permissions. Never execute repository scripts. Preserve source URL, revision and license attribution.
- [x] Full tests/build/lint/structure, native fixture smoke, review, release package, Mac mini deployment, HTTPS/session checks, documentation and push main.

Shared configuration fields: Codex `mcp_servers`, `plugins`, skill/agent declarations and marketplace configuration; Claude `.claude.json.mcpServers` plus `settings.json.enabledPlugins` and `extraKnownMarketplaces`; OpenCode `mcp`, `plugin` and agent definitions, including its TUI plugin list. Other native settings, provider keys/models, auth state and permissions remain account-specific. Project-local settings continue to follow each CLI's native precedence.

Native sources checked: Claude directory/plugin references, OpenCode config/custom-directory and agents docs, official Codex config reference and plugin store implementation. Agency upstream conversion emits Codex `name`, `description`, `developer_instructions`, Claude agent Markdown and OpenCode `mode: subagent` Markdown.

Completion evidence: [release verification](../../refactor/shared-cli-extensions-report.md).
