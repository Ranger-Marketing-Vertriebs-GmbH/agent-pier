# Central MCP servers for coding CLIs — design

Plane: AGENTPIER-38 (epic AGENTPIER-21). Follow-ups: AGENTPIER-45 (per-account
bindings, backlog), AGENTPIER-42 (backups, after this).

## Goal

The central MCP server list (Accounts → MCP servers, AGENTPIER-29) becomes the one
place where the owner keeps MCP servers. Each server can be bound to OpenClaw agents
(today) **and** to the coding CLIs Claude Code, Codex and OpenCode. A server bound to
a CLI works in AgentPier sessions **and** when the owner starts that CLI directly in
a terminal, because AgentPier writes it into the CLI's own configuration, the same way
the CLI extensions do today. The MCP part of the CLI extensions is replaced by the
central list; nothing the owner configured today stops working.

## Owner decisions (2026-10-12)

1. CLI bindings write into the CLIs' native configuration (servers also work outside
   AgentPier). Existing MCP entries in the CLIs are not removed.
2. One list: the central list replaces the MCP management of the CLI extensions.
3. Bindings are per CLI (all accounts of that CLI through the shared CLI profile).
   Per-account bindings are AGENTPIER-45 (low priority).
4. OAuth: AgentPier writes the server in each CLI's OAuth form and shows a login hint;
   a feasibility probe decides whether AgentPier can broker CLI logins as it does for
   agents (option C). Brokering is built only if the probe shows it works.
5. Entries added to a CLI outside AgentPier are shown as "found" with **Adopt**; never
   adopted automatically, never modified while unmanaged.

## Current state (origin/main 2026-10-12)

- Central store: `server/features/mcp-servers/mcp-server-store.js` (SQLite
  `<data>/mcp-servers/servers.sqlite`): `servers`, `server_secrets` (header/env
  values), `bindings(server_id, target_kind, target_id)` with
  `targetKinds = ["agent"]`. Names follow OpenClaw's rule
  `^[A-Za-z][A-Za-z0-9_-]{0,29}$`. Transports `http`, `sse`, `stdio`; auth `headers`
  or `oauth` (remote only).
- CLI extensions: `server/features/extensions/extension-store.js` writes user MCP
  entries directly into the native files through `mcp-config.js` (`readConfig`,
  `updateConfig`, `atomicText` compare-and-swap, mode 0600, `safePath`). Native shapes:
  `nativeMcp()` (stdio and http only; `sse` rejected).
- Shared CLI profiles: one canonical native profile per CLI (`local-<tool>`);
  `SharedCliProfiles.prepare()` (`server/features/cli-profiles/`) projects shared MCP
  fields into managed accounts at every launch and keeps hash baselines in
  `<data>/shared-cli-profiles.json`. Native files: Codex `config.toml`
  `mcp_servers`; Claude Code `.claude.json` `mcpServers`; OpenCode
  `opencode.json`/`opencode.jsonc`/`config.json` `mcp`.
- AgentPier's own servers (`agentpier_*`) are per-launch and never written to native
  files; they are unaffected.
- nono: session sandbox grants via `addGrant`; nothing grants user MCP stdio servers.

## Design

### 1. Model and ownership

- New binding target kind `cli` with target ids `claude`, `codex`, `opencode`
  (`targetKinds = ["agent", "cli"]`). Agent bindings are unchanged.
- **Managed entries.** For each `cli` binding AgentPier writes one entry, named as the
  server, into the CLI's shared native profile through the existing `mcp-config.js`
  write path. AgentPier records each written entry in its own data (new table
  `cli_entries(server_id, cli, name, hash, written_at)` in the server store): no marker
  is added to native files. The hash is over the native entry as written.
- An entry is **managed** when the store records it and the file's entry still hashes
  to the recorded hash. A recorded entry whose content changed is a **conflict**;
  an entry the store does not record is **unmanaged** (a "find").
- Unbinding or deleting removes the managed entry only when its hash still matches;
  a changed entry stays in the file and becomes a find.
- Unmanaged entries are never modified or removed. A binding whose name is taken by an
  unmanaged entry is not written ("name taken") and offers **Adopt**.
- **Secrets.** The store keeps header/env values as today. Native files hold them in
  plain text because the CLIs read them from there (as CLI extensions do today);
  files are written with mode 0600 through the existing path. Values never appear in
  logs, audit details or API responses (names only), extending AGENTPIER-41's rule.

### 2. Per-CLI behavior and when AgentPier writes

- **Transport support** (verified against the installed CLIs by a contract, Task 1):
  Claude Code stdio/http/sse; Codex stdio/http (no SSE); OpenCode stdio (`local`) and
  remote (`remote`; SSE support confirmed by the contract or disabled). Unsupported
  combinations are refused by the API (`400 MCP_CLI_TRANSPORT_UNSUPPORTED`) and shown
  disabled with a reason in the form.
- **Native projection** extends `nativeMcp()` with `sse` (Claude Code
  `{type:"sse",url,headers}`, OpenCode remote) and OAuth forms per CLI: no static
  auth headers; Claude Code `{type:"http"|"sse",url}` (the CLI runs OAuth when the
  server challenges), Codex `{url}` (login with `codex mcp login`), OpenCode
  `{type:"remote",url,oauth:{...scope}}`. Exact shapes are pinned by the contract.
- **Names.** Central names keep the OpenClaw rule. Adopting a find with an invalid
  name proposes a valid one; on adopt AgentPier replaces the old native entry with a
  managed one under the new name (only if the old entry is unchanged since it was
  read).
- **When.** On every save in the central list (bind, unbind, edit, delete), and before
  every session start in `prepare()` (restore a missing managed entry; never touch a
  conflict). CLIs read their config at start, so running sessions see a change after a
  restart; the UI says so.
- **Accounts.** Entries go into the shared profile; the existing projection carries
  them to managed accounts. Hash baselines in `shared-cli-profiles.json` are kept
  consistent so the projection does not report AgentPier's own writes as drift.
- **Sandbox.** For a nono session, each bound stdio server gets read grants for its
  resolved command, its interpreter when the command is a script with a shebang, and
  its `cwd` (allow). Remote servers need none.
- **OAuth.** Status per CLI from the CLI where it can be read
  (`codex mcp list`/`opencode mcp list` JSON or equivalent, probed in Task 1), else
  "login required in <CLI>: run `/mcp` / `codex mcp login <name>` /
  `opencode mcp auth <name>`". The brokering probe (Task 1) records whether each CLI
  can complete a login started by AgentPier with a callback through AgentPier's
  origin; brokering is a separate follow-up task only for CLIs where it works.
- **CLI extensions page.** The MCP section is replaced by a link to the central list;
  plugins, skills and marketplaces stay.

### 3. UI, errors and tests

**UI (Accounts → MCP servers)**

- Each server shows its users: "Agents: Home, Lead · CLIs: Claude Code, Codex".
- The form gets a **Coding CLIs** block with three checkboxes; disabled with a reason
  where the transport is unsupported.
- Per bound CLI a status: written; conflict (edited by hand) with **Write AgentPier's
  version** / **Adopt the change**; name taken (**Adopt**); OAuth login required with
  the CLI's command; could not write (reason).
- **Found in the CLIs** lists unmanaged entries with **Adopt** and **Adopt all**.
  Identical entries (same name and same normalized content) from several CLIs merge
  into one server with several CLI bindings; same name with different content stays
  separate. Invalid names get a proposal. Values are never shown, names only.
- All copy in de and en.

**Errors**

- A native file that cannot be parsed is never written; that CLI shows "could not
  write"; other CLIs and agents continue.
- A file that changes between read and write (compare-and-swap) is re-read and the
  write retried with the new content, bounded.
- Conflicts and taken names never overwrite; they wait for the owner.
- Store and file changes are ordered so a crash between them is repaired by the next
  `prepare()`/save reconciliation (store first, then file; the reconciler compares
  both).

**Tests**

- Unit/integration with fixture native files for all three CLIs: write, unbind,
  delete, conflict, taken name, malformed file, concurrent change, finds, merging,
  name proposals, no values in responses/logs/audit, nono grants.
- Contracts against the installed CLIs in an isolated HOME (never the owner's):
  `claude mcp list`, `codex mcp list`, `opencode mcp list` accept the written entries
  for each supported transport and auth; unsupported ones are confirmed unsupported.
- Browser (Chromium; WebKit in CI): checkboxes and reasons, statuses, finds and adopt,
  conflict choices, de and en.
- Audit: bind/unbind to CLIs and adopt are audited like AGENTPIER-41 (names only).

## Out of scope

Per-account bindings (AGENTPIER-45); backups of the store (AGENTPIER-42); brokered
OAuth for CLIs unless the probe proves it; per-project bindings; AgentPier's own
`agentpier_*` servers.
