# Central MCP servers bound to agents

Status: agreed design. Plane: AGENTPIER-29 (step 7 of AGENTPIER-21).

Date: 2026-10-11

## Goal

AgentPier keeps one central list of MCP servers. The owner binds servers to agents
once; the binding holds until changed, with no choice per launch. A lead agent may
pass a subset of its own servers to temporary team members it proposes. Binding
servers to coding CLI profiles follows in AGENTPIER-38 and OAuth sign-in in
AGENTPIER-37; the data model already allows both.

## Decisions

- **Transports:** HTTP (`streamable-http` or SSE) and local stdio.
- **stdio warning:** stdio servers run commands with the owner's macOS rights and
  no sandbox. Adding one, and binding it to an agent, requires a clear warning and
  an explicit confirmation, as for full shell access. The agent settings show
  which bound servers are stdio.
- **Secrets:** header and environment values live in AgentPier's backend store.
  Responses never contain them; the UI shows only names (the `publicMcp`
  redaction pattern of `server/features/extensions/mcp-config.js`). The compiler
  writes them into the private `openclaw.json` (mode 0600, like provider keys) so
  MCP changes hot-reload. Update backups seal MCP `headers` and `env`; the existing
  gap for `env` in `backup-credentials.js` is closed.
- **stdio command resolution:** the Gateway runs with a restricted `PATH`. On save,
  AgentPier resolves a bare command (for example `npx`) once against the owner's
  login `PATH` and stores the absolute path (for example
  `/opt/homebrew/bin/npx`). The UI shows the resolved path. An absolute command is
  kept as entered. A command that cannot be resolved is rejected.
- **Eligibility:**
  - Personal agents and permanent team members: bindings managed by the owner in
    the agent settings.
  - Temporary team members: the lead agent names, per proposed member, a subset of
    the lead's own bound servers. The team proposal the owner approves shows
    these servers, with the stdio warning where it applies. The bindings end with
    the member.
  - Archived agents: none.

## Architecture

### Store

A backend store `mcp-servers` with:

- `servers(id, name, transport, url | command, args, cwd, settings, revision)`,
  non-secret fields only;
- `server_secrets(server_id, kind: header | env, name, value)`;
- `bindings(server_id, target_kind, target_id)`, where `target_kind` is `agent`
  now and `cli-profile` later.

Names follow the existing MCP name rule and must stay unique after OpenClaw's
tool-name sanitisation (characters outside `[A-Za-z0-9_-]` become `-`). Validation
reuses `mcp-config.js` (`nameValue`, `values`, URL checks: no credentials, no
fragment). An owner route manages servers and bindings; responses are redacted.

### OpenClaw configuration

- `mcp.servers.<name>` is compiled only for servers bound to at least one eligible
  agent; `mcp` is a locked path (since AGENTPIER-24), so its content always comes
  from the store.
- Global `tools.allow` gains `bundle-mcp` when any server is compiled; each agent's
  entry gains `<sanitised name>__*` for its bound servers. Agents without bindings
  are unchanged.
- The computation is a pure section builder next to
  `openclaw-config/web-tools.js`, with the same availability rules for start and
  live apply.
- Whether adding `bundle-mcp` under the team mode's restrictive `plugins.allow`
  needs a Gateway restart is verified live first. If it does, the owner-confirmed
  restart flow of AGENTPIER-24 applies; otherwise changes hot-apply through
  `patchConfig`.

### Teams

- The team proposal (`team-store.js` `propose`) accepts an optional per-member
  `mcpServers` list. Each name must be bound to the lead agent; anything else
  rejects the proposal.
- The approval view and the Telegram approval message list the servers per
  member, marking stdio ones.
- Approved temporary members get the bindings when they are created; the
  bindings are removed when the member ends.
- The team write guard is unchanged. It covers workspace writes only; what an MCP
  tool can do depends on the server, which is why the owner sees the list before
  approving.

### UI

- An "MCP servers" section in the AgentPier settings (German and English, phone
  width), based on the existing MCP form. It covers adding, editing, removing and
  the stdio warning, and shows the resolved command path.
- In the agent settings, a server selection with the stdio marker.
- The team approval shows the servers per member.

## Testing

- Unit:
  - validation and redaction;
  - command resolution with a fake `PATH`;
  - section builder (no bindings means byte-identical output; per-agent globs;
    sanitised names; temporary members only through team bindings);
  - backup sealing of `env`;
  - proposal validation (subset of the lead's servers).
- Browser: the server list, the stdio confirmation, agent binding and the team
  approval list, in German and English.
- Live contract against OpenClaw 2026.9.8:
  - a local HTTP MCP test server and a stdio test server, each bound to one agent;
  - the agent is offered their tools and an unbound agent is not;
  - a tool call reaches the server;
  - the restart question for `bundle-mcp` in team mode is answered and recorded.
- Existing assistant, team and capability tests are unchanged.

## Out of scope

OAuth (AGENTPIER-37), coding CLI bindings and import (AGENTPIER-38), per-project
bindings, sandboxing stdio servers.
