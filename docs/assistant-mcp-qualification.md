# MCP client qualification

An opt-in contract checks how OpenClaw 2026.9.8 connects the MCP servers that
AgentPier binds to agents (AGENTPIER-29). It runs a real isolated Gateway, started
by `RuntimeSupervisor` in a temporary data directory, with two local test servers
from `tests/helpers/mcp-test-servers.js`:

- a stateless **Streamable HTTP** server on `127.0.0.1`, and
- a **stdio** server, started by the Gateway as `<absolute node> <script> <record>`.

Each exposes one tool, `echo`, that answers `echo:<text>` and records the call (the
HTTP server with the request headers; the stdio server in a JSON lines file, with
the environment it started with). The deterministic model from
`tests/helpers/assistant-model-server.js` calls the tools. No external server,
model account or credential is involved.

Two contracts use them.

`tests/integration/assistant-mcp-contract.test.js` qualifies OpenClaw itself, with
`mcp` written by hand through `patchConfig`:

1. HTTP and stdio servers for one bound agent, not for an unbound one (allow lists,
   calls, environment, process lifetime, removal, no restart, no leaked values).
2. An HTTP server without `transport` (SSE by default).
3. Sanitised, prefixed and truncated server names.
4. The same servers under the team plugin's restrictive `plugins.allow`.

`tests/integration/assistant-mcp-compiled-contract.test.js` drives AgentPier's own
path in team mode: the server store, `AssistantService`, `TeamService` with the
team bridge and plugin, the start compile and `McpChanges`' live patches:

1. **Compiled start and live changes.** An HTTP server with a header and a stdio
   server (bare `node`, resolved by the store to an absolute path) with an
   environment value, created and bound through the owner's path (stdio refused
   without confirmation). The start compiles exactly those servers, `bundle-mcp`
   and the bound agent's globs; the bound agent is offered and reaches both
   servers, an unbound agent neither. Then, on the running Gateway and without a
   restart: binding the HTTP server to the second agent, rotating its header (the
   next call carries the new value), removing the stdio server (the `null` merge
   with `replacePaths: ["mcp.servers.local.args"]`; its processes end) and removing
   the last server (the global grant and every glob go).
2. **Team member.** A lead bound to the HTTP server proposes, through the team
   plugin tool on the deterministic model, a member with `mcpServers: ["docs"]`.
   The proposal awaits approval and lists the server; the owner approves; the
   scheduler binds, patches and provisions the member, whose own turn is offered
   `docs__echo` and calls the server. When the member's run completes, its binding,
   its glob and its tools are gone while the lead keeps them; no restart happens.

Some details below (marked _probe_) come from manual probes on 2026-10-11 and are
not repeated by the contracts.

## Running the contract

```sh
touch /tmp/contracts.env
node scripts/provision-assistant-contracts.mjs --data-dir /tmp/agentpier-contracts --env-file /tmp/contracts.env
set -a; . /tmp/contracts.env; set +a
node --test --test-concurrency=1 tests/integration/assistant-mcp-contract.test.js \
  tests/integration/assistant-mcp-compiled-contract.test.js
```

Both need `AGENTPIER_MCP_CONTRACT_RUNTIME` and `AGENTPIER_ASSISTANT_CONTRACT_DIR`
and skip without them. The `native-contracts` CI job runs them with the other
native contracts and fails on any skip.

On 2026-10-11 both passed on macOS arm64 (Darwin 25.5) against the
`2026.9.8-node26.7.0-darwin-arm64-lock563cf3904093` runtime, whose lock equals the
current `runtime-lock/package-lock.json`: the OpenClaw contract with 4 tests in
about 50 seconds, the compiled contract with 2 tests in about 30 seconds, 0 skips
and 0 failures each.

## Verified facts

### (a) Server shapes

`config.schema.lookup` on `mcp.servers.*` lists `enabled`, `command`, `args`,
`env`, `cwd`, `url` (format `uri`), `transport` (`stdio` | `sse` |
`streamable-http`), `headers`, `connectionTimeoutMs`, `requestTimeoutMs`,
`supportsParallelToolCalls`, `auth` (`oauth`), `oauth`, and further fields.
`headers.*` and `env.*` carry the hint `sensitive: true`; `url` carries
`url-secret`.

HTTP, as the contract writes it:

```json
{
  "url": "http://127.0.0.1:<port>/mcp",
  "transport": "streamable-http",
  "headers": { "X-Fixture-Marker": "<value>" }
}
```

- Without `transport` OpenClaw uses **SSE**: against a Streamable HTTP server it
  only opens `GET` with `Accept: text/event-stream`, never posts an MCP message and
  offers no tools. AgentPier must always write `transport` for HTTP servers.
- The configured headers reach the server on every request.

stdio:

```json
{
  "command": "/absolute/path/to/node",
  "args": ["/absolute/script.js", "<argument>"],
  "env": { "MCP_FIXTURE_SECRET": "<value>" },
  "cwd": "/absolute/working/directory"
}
```

- `env` values reach the process; `cwd` becomes its working directory. Without
  `cwd` it runs in the Gateway's working directory (`<data>/assistants`, _probe_).
- A bare `command: "node"` resolved to the runtime's own Node (first on the
  Gateway's `PATH`), not the user's (_probe_). AgentPier stores absolute commands.

### (b) Tool names

Tools are offered as `<prefix>__<tool>`. The prefix is derived from the server name:

| `mcp.servers` key                          | Offered tool                  |
| ------------------------------------------ | ----------------------------- |
| `docs.v2-http`                             | `docs-v2-http__echo`          |
| `local-stdio`                              | `local-stdio__echo`           |
| `My Server`                                | `My-Server__echo`             |
| `Upper_Case`                               | `Upper_Case__echo`            |
| `9lives`                                   | `mcp-9lives__echo`            |
| `xxxx…` (40 × `x`) `-tail`                 | `xxxx…` (30 × `x`) `__echo`   |
| `xxxx…` (40 × `x`) `-other`, second server | `xxxx…` (28 × `x`) `-2__echo` |

- Characters outside `[A-Za-z0-9_-]` become `-`; **case is kept** (the upstream
  documentation's lower-case example does not hold for this release).
- A name that does not start with a letter gets the prefix `mcp-`.
- The prefix is truncated to 30 characters; a collision gets `-2` within the same
  30 characters, in configuration order.
- An allow entry with the raw name (`docs.v2-http__*`) matches nothing; the
  Gateway logs it as an unknown allowlist entry. AgentPier must write the
  sanitised prefix, keep names short (at most 30 characters) and reject names
  that collide after sanitisation.

### (c) Allow lists

The tools are offered only when **both** levels allow them:

| Global `tools.allow`      | Agent `tools.allow` | Offered to the agent |
| ------------------------- | ------------------- | -------------------- |
| `+ bundle-mcp`            | unchanged           | none                 |
| unchanged                 | `+ <prefix>__*`     | none                 |
| `+ bundle-mcp`            | `+ <prefix>__*`     | that server's tools  |
| `+ <prefix>__*` (_probe_) | `+ <prefix>__*`     | that server's tools  |
| `+ bundle-mcp`            | `+ bundle-mcp`      | every server's tools |

The design's form (global `bundle-mcp`, per-agent `<prefix>__*`) is verified in
plain and team mode, by hand and as compiled. An agent without a glob is offered
none of the tools, and its own call to one does not reach either server. A
temporary team member is offered exactly the servers its approved proposal named
while it runs, and none after it ended.

### (d) Team mode and restarts

Under the team plugin's `plugins.allow: ["agentpier-teams", "memory-core"]`,
adding `mcp.servers`, the global `bundle-mcp` and the agent globs **hot-applies**:

- the bound agent is offered and calls both servers' tools on the next session;
- the Gateway generation is unchanged and its log has no
  `requires gateway restart`;
- the next `config.patch` is accepted (unlike the browser case in
  [web tools](assistant-web-tools-qualification.md#f-reload-kinds), where a
  pending recovery restart refuses it);
- `plugins.allow` stays unchanged. `bundle-mcp` is not a plugin in `plugins.list`
  and does not belong in `plugins.allow`.

The owner-confirmed restart flow of AGENTPIER-24 is therefore not needed for MCP
changes; they can go through `patchConfig`.

### (e) Reload kinds

`config.schema.lookup` reports `reloadKind: "hot"` for `mcp`, `mcp.servers`,
`mcp.servers.*.url`, `.transport`, `.headers`, `.command`, `.args`, `.env`,
`.cwd`, and `tools.allow`. The live behaviour matches: adding servers took effect on the
next session without a restart in both modes; removing servers, rotating a header
and changing bindings did so in plain mode and, through `McpChanges`, in team mode.

Removing a server needs care: a merge patch `{ mcp: { servers: { <name>: null } } }`
is refused with `INVALID_REQUEST: config.patch would remove entries from array
path(s): mcp.servers.<name>.args`. It is accepted with
`replacePaths: ["mcp.servers.<name>.args"]` (every array the server has).
`replacePaths: ["mcp.servers"]` does not remove keys (it applies to arrays only,
_probe_). Disabling with `enabled: false` is accepted (_probe_).

Changing a header value by merge patch takes effect on the next call (compiled
contract), and a patch that leaves a redacted value untouched keeps the stored
value (_probe_). After the last server is removed, an empty `mcp.servers` stays in
the live configuration until the next start drops it; it is harmless.

### (f) stdio process lifetime and environment

- The Gateway starts **one stdio process per session**, for every session of
  every agent once the server is configured, including agents that are not
  offered its tools: discovery does not follow the allow lists. The HTTP server
  likewise received discovery requests before any agent was allowed its tools
  (_probe_).
- These processes stay up after the turn. They end when the server is removed
  from the configuration (within about 5 seconds, with a normal exit) or when the
  Gateway stops.
- `mcp.sessionIdleTtlMs: 1500` did not end idle processes within 6 seconds
  (_probe_); the idle eviction is not qualified.
- The process inherits the Gateway's environment, not the owner's:
  - `HOME` is the Gateway's private home (`<data>/assistants/home`);
  - `TMPDIR` is **not set**;
  - `PATH` is `<runtime>/node/bin:/usr/bin:/bin` followed by OpenClaw's standard
    directories, on macOS `/opt/homebrew/bin:/usr/local/bin`. A bare command
    (`npx`, `uvx`) installed elsewhere, for example by nvm or in `~/.local/bin`,
    does not resolve. AgentPier resolves and stores absolute commands on save,
    as the design decides.

### (g) Secret values

With a header value and an environment value set:

- `config.get` returns `__OPENCLAW_REDACTED__` for both, and its serialised form
  contains neither value.
- No tool result, session transcript, log (`gateway-console.log`,
  `openclaw.log`) or other file below the data directory contains them, except
  copies of the configuration itself: `openclaw.json`, its atomic-write
  temporary, `.bak` … `.bak.4` and `.last-good` (all mode 0600).
- After a value is changed, the old value stays in the configuration backups
  until they rotate out (_probe_). The compiled contract checks the old and the new
  header value: apart from those copies, only AgentPier's own server store holds
  them.
- AgentPier's runtime update backups and host backups seal `headers` and `env` in
  `openclaw.json` and in every copy beside it that parses as JSON (`.bak*`,
  `.last-good`); a copy that does not parse (an unfinished temporary) is left out.
  `tests/integration/assistant-runtime-snapshot.test.js` and
  `tests/integration/assistant-host-backup.test.js` verify the restore with the key
  and the withheld restore after the key was destroyed.

### (h) Agent placeholders and OpenClaw 2026.10.3

Read from the pinned runtime's documentation (`docs/tools/mcp.md`) and compiled
source (`dist/`) for the [agent placeholders](mcp.md#agent-placeholders) (AGENTPIER-149),
not by a contract run:

- `mcp.servers` is one Gateway-wide map. Its schema (`McpConfigSchema`) has no
  per-agent block, and an agent entry has no MCP override; a session's tool overrides
  can only switch a configured server on or off by name
  (`loadMergedBundleMcpConfig`). Environment values cannot differ per agent within
  one entry.
- Values are passed to the process as written. The only placeholders OpenClaw
  resolves are a plugin bundle's own `${CLAUDE_PLUGIN_ROOT}`, `${PLUGIN_ROOT}` and
  `${PLUGIN_DATA}`, never for `mcp.servers` entries.
- stdio servers run in a **session** MCP runtime (`SESSION_MCP_RUNTIME_MANAGER_KEY`,
  keyed by session): one process per configured server and session, created when the
  session's tool allow list can reach an MCP namespace. `mcp.sessionIdleTtlMs` is
  opt-in; unset or `0` keeps the runtime for the session's lifetime, a positive value
  evicts idle runtimes (swept every minute). AgentPier does not set it.
- Consequence: per-agent folders need one compiled entry per agent binding. Each
  entry is another server name, so the agent's tool prefix changes to that entry's
  name, and a session that starts its runtime may also start other agents' entries
  (without being offered their tools), as with any configured server.

## Consequences for AgentPier

- Compile `mcp.servers` only for servers bound to an eligible agent: every
  configured stdio server starts a process for every session, bound or not.
- Write `transport` explicitly for HTTP servers.
- A server with agent placeholders compiles one entry per bound agent, each with
  that agent's folders and its own name and glob (section (h)).
- Validate names so that the sanitised prefix is unique, at most 30 characters
  and starts with a letter; write the sanitised prefix into the agent globs.
- Add `bundle-mcp` to the global `tools.allow` and `<prefix>__*` to each bound
  agent's `tools.allow`; leave `plugins.allow` unchanged.
- Live changes go through `patchConfig`; removals list each removed server's
  array paths (`args`) in `replacePaths`.
- stdio commands must be absolute; servers that need `TMPDIR` or the owner's
  `HOME` will not find them.
- Rotated header or environment values linger in OpenClaw's configuration
  backups. Update and host backups therefore seal every `openclaw.json*` copy that
  parses like `openclaw.json` itself and leave out copies that do not; data
  deletion must treat these files as secret too.

## Boundaries

- Linux was not run locally; the contracts accept OpenClaw's Linux standard
  directories on `PATH` and rely on the CI job.
- The team contract covers an owner-approved proposal and a member whose run
  completes. Automatically approved teams, owner stops, a permanent approval and a
  lead losing a server use the same reconciliation and are covered against a fake
  Gateway (`tests/integration/assistant-team-mcp.test.js`).
- SSE servers were not exercised beyond the default-transport check. OAuth
  (AGENTPIER-37) has its own contracts, recorded in the
  [MCP OAuth qualification](mcp-oauth-qualification.md).
- The idle eviction (`mcp.sessionIdleTtlMs`) and session cleanup of stdio
  processes are not qualified.
- Stdio env filtering (`NODE_OPTIONS`, `DYLD_*` and similar, documented upstream)
  was not exercised.
