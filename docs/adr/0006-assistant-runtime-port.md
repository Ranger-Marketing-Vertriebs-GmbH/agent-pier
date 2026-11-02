# Agent runtime port: OpenClaw and Hermes side by side

---

Status: proposed; not implemented.

Date: 2026-11-01

---

## Context

[ADR 0002](0002-managed-openclaw-assistants.md) put OpenClaw behind an adapter and kept
Hermes Agent as a fallback. In practice the adapter boundary is thin: 51 backend files
call 45 distinct Gateway methods directly (`sessions.*`, `chat.history`, `cron.*`,
`exec.approval*`, `agents.files.*`, `skills.status`, `browser.request`, `models.*`, …),
30 more reach `runtime.client` indirectly, the configuration compiler
(`openclaw-config/`) produces OpenClaw's `openclaw.json` shape, the team plugin runs
inside the OpenClaw process, and `exec-allowlist-policy.js` reads lists from the
OpenClaw distribution. 58 contract tests pin OpenClaw behaviour.

The owner wants Hermes Agent as a second runtime **in parallel to OpenClaw, chosen per
agent**, at feature parity where Hermes allows it. The
[Hermes runtime spike](../research/hermes-runtime-spike.md) found parity reachable for
chats, sessions, approvals, routines, MCP, skills, memory, models and Telegram, with two
areas that need AgentPier-owned work: browser live view and takeover, and per-agent
isolation when several agents share one process.

OpenClaw was first locked down and then relaxed over many changes. The owner does not
want that sequence again: Hermes agents start with practical defaults.

## Decision

### 1. The runtime is a property of each agent

Every agent records `runtime: "openclaw" | "hermes"`. Existing agents and new agents
default to `openclaw`. The runtime is chosen when the agent is created; moving an
existing agent to another runtime is a separate, later migration (Hermes ships
`hermes import-agent openclaw`, which is a candidate). Both runtimes may run at the
same time on one host. Agents switch on with at least one runtime installed.

### 2. One runtime port; feature code never talks to a runtime directly

Feature code depends on an `AgentRuntime` port, resolved per agent. Each sub-port has
one OpenClaw and one Hermes implementation:

| Port         | Responsibility                                                                                                              | OpenClaw today                                                   | Current callers                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`       | install, start, stop, health, version, update, rollback, restart reasons                                                    | supervisor, installer, lock, TLS pin, `gateway-client.js`        | `runtime-*.js`, `gateway-*.js`, `pending-restart.js`                                                                                                                                                                                                                                                                                                                                                                                          |
| `sessions`   | create, send, abort, wait, describe, list, delete, archive, history, compact                                                | `sessions.*`, `chat.history`, `agent.wait`, `artifacts.download` | `session-create`, `main-chat-swap`, `conversation-turns`, `conversations`, `conversation-open`, `chat-reconcile`, `agent-chats`, `run-reconciler`, `run-stall-guard`, `attempt-recovery`, `assistant-service`, `shell-changes`, `runtime-update-resolution`, `chat-removal`, `native-chat-archive`, `long-chats`, `member-long-chats`, `compaction-watch`, `cron-result-text`, `generated-images`, `team-provisioning`, `telegram-follow-ups` |
| `events`     | normalized run events: started, text delta, tool step, approval requested/resolved, finished, aborted, failed (with reason) | `chat` frames, `exec.approval.*` events                          | `gateway-wiring`, `run-steps`, `gateway-event-hub`                                                                                                                                                                                                                                                                                                                                                                                            |
| `agents`     | create, update, delete, list the runtime-side agent                                                                         | `agents.*`                                                       | `assistant-config`, `agent-admission`, `agent-deletion`, `assistant-maintenance`, `runtimes/openclaw/agent-roster`                                                                                                                                                                                                                                                                                                                            |
| `agentFiles` | instructions, memory and workspace files                                                                                    | `agents.files.*`, `tools.invoke`                                 | `assistant-config`, `native-memory`                                                                                                                                                                                                                                                                                                                                                                                                           |
| `config`     | apply the desired state compiled from AgentPier's model; report whether a restart is needed                                 | `config.get`/`patch`/`schema.lookup`                             | `runtimes/openclaw/live-patch`, `advanced-config`, `mcp-changes`, `telegram-live`, `assistant-config`                                                                                                                                                                                                                                                                                                                                         |
| `approvals`  | pending approvals, resolve, history, allowlist                                                                              | `exec.approval*`, `exec.approvals.*`, `approval.history`         | `exec-approvals`, `exec-decisions`, `exec-allowlist`                                                                                                                                                                                                                                                                                                                                                                                          |
| `routines`   | add, update, remove, run, list runs                                                                                         | `cron.*`                                                         | `native-routines`, `native-reminders`, `native-heartbeats`, `agent-hook-runs`, `agent-own-jobs`, `routine-edits`, `lead-routines`, `user-release`, `assistant-maintenance`                                                                                                                                                                                                                                                                    |
| `skills`     | per-agent skill status and eligibility                                                                                      | `skills.status`                                                  | `agent-skills`, `assistant-config`, `skill-catalog-wiring`, `routes/agent-skill-catalog`                                                                                                                                                                                                                                                                                                                                                      |
| `browser`    | profiles, live view, input, takeover                                                                                        | `browser.request`                                                | `agent-browsers`, `browser-live-view`                                                                                                                                                                                                                                                                                                                                                                                                         |
| `models`     | catalog, probe, login, logout, status                                                                                       | `models.*`, `wizard.*`                                           | `model-account-catalog`, `model-account-login`, `model-accounts`                                                                                                                                                                                                                                                                                                                                                                              |
| `channels`   | channel status                                                                                                              | `channels.status`                                                | `telegram-senders`                                                                                                                                                                                                                                                                                                                                                                                                                            |

Every port also exposes `capabilities()`. A capability a runtime lacks is shown to the
owner with the reason, never silently hidden, and the backend refuses the operation with
a translated message.

Adapters live in `server/features/assistants/runtimes/openclaw/` and
`server/features/assistants/runtimes/hermes/`. `gateway-client.js`, `gateway-protocol.js`,
`gateway-tls.js`, `openclaw-config/`, `exec-allowlist-policy.js`, the team plugin and
the OpenClaw contract tests move into the OpenClaw adapter. A unit test fails when code outside `runtimes/` calls a
runtime client or names a runtime method; its allowlist starts with today's files and may
only shrink, as `tests/unit/ui-guide-rules.test.js` does for the UI. Step 1 of the
delivery order emptied it: the rule is now absolute, without an allowlist.

The host sub-port separates AgentPier's lifecycle from the runtime's. AgentPier keeps
the update journal (`runtime-updates.js`: staging, maintenance, snapshot, validation,
rollback, recovery), its blockers and retention, and the pending restart
(`pending-restart.js`: why a saved change waits for a restart). The adapter installs
its runtime (`install`, `sameInstall`), names the version it ships and whether an
install record is it (`target`, `current`), stages an update in the background
(`stageUpdate`), migrates stopped state to a new version and cleans up before a
rollback (`migrate`, `stopMigration`, `clearMigration`), and tells whether a change
needs a restart and which start loaded the running configuration (`restartNeeded`,
`generation`). OpenClaw's supervisor, installer, manifest, dependency lock, Doctor
migration and process ownership therefore live in `runtimes/openclaw/`. A second
rule of the same test refuses imports of adapter modules from outside `runtimes/`:
only `runtime-for.js` and `agent-runtime.js` are public, composition roots may
construct the supervisor, and a shrink-only allowlist names the MCP toolchain
manifest (it shares OpenClaw's Node pin) and the team plugin installer (it checks
OpenClaw's versions until the team plugin moves into the adapter).

### 3. AgentPier owns a runtime-neutral desired state

AgentPier describes each agent as data: instructions, model connection, tools and
their grants, shell mode, MCP bindings, skills, web tools, browser, channels, routines.
Each adapter compiles that model into its runtime's configuration (`openclaw.json`
entries; Hermes `config.yaml`, `.env` and plugin folders). Routines already have their
neutral model (`server/features/assistants/routine-definition.js`); the routines
sub-port takes and returns it, and each adapter translates it into its scheduler's
jobs. Keys a runtime writes itself
(Hermes writes `onboarding.seen.*`, `_config_version` and gateway flags) are runtime
state: the compiler preserves them and never produces duplicate keys.

### 4. Hermes adapter shape

- **One Hermes process per agent**, each with its own `HERMES_HOME` inside AgentPier's
  private runtime folder. This avoids Hermes's process-wide MCP registration and
  terminal environment in multiplexed mode, at about 150–180 MB per agent (spike).
- **Control over JSON-RPC to the agent's own messaging gateway**, the process set's
  owner (see "host as built" below). The first plan, stdio JSON-RPC of
  `python -m tui_gateway.entry`, cannot share a home with the messaging gateway that
  routines and Telegram need, so the RPC bridge carries the gateway's session protocol
  over stdio instead. AgentPier opens no listener and the bridge's ticket never leaves
  it; the gateway's own loopback listener stays reachable by the agent's shell, as the
  spike found. Each start connects a new client (`runtimes/hermes/hermes-runtime.js`
  composes host, sessions, events, approvals and the compiler, which writes the
  agent's `HERMES_HOME` before each start). `runtime-for.js` registers Hermes; each Hermes agent
  resolves to its own process set in the Hermes fleet (`runtimes/hermes/hermes-fleet.js`),
  attached to the supervisor callers pass ([agents on Hermes](../hermes-runtime.md#agents-on-hermes)).
- **Sessions, run events and approvals** (`runtimes/hermes/`) over the gateway's
  session store, which differs from the stdio server: sessions have one durable id,
  a connection attaches to a session (`session.resume`) before it may submit there,
  `session.create` takes a `request_id` and the title, `prompt.submit` requires a
  `submission_id`, every method refuses unknown parameters (`invalid_params`), and
  refusals carry their reason (`not_found`, `session_busy`, `stale_generation`, …)
  under code 4001. Edits (`session.mutate`: compress, archive, delete) are fenced on
  the session's revision and interrupts and approval answers on its execution
  generation; the adapter tracks both and repeats a fenced refusal once with the
  fences it names. Session keys are `agent:<runtimeAgentId>:hermes:<session id>`, so
  keys survive a restart. A turn's run id is its idempotency key, as with OpenClaw,
  and Hermes's `admission_id` on every frame of the turn maps the frame to it.
  Approvals arrive as `approval.request` events and are answered with
  `approval.respond`; they become the exec approvals OpenClaw's adapter produces,
  offering allow once, allow for the session and deny. Hermes's `always` is never
  offered, because it allows the whole pattern class for good. Clarify questions
  (`clarify.request`) wait for the owner in the agent's chat and, for a turn from
  Telegram, in the paired Telegram chat; the answer goes back with `clarify.respond`
  (AGENTPIER-337). Secret and sudo requests are declined at once with Hermes's own
  empty answer, so the agent goes on instead of waiting out Hermes's deadline. Gaps the adapter reports: artifact downloads, the exec allowlist (Hermes
  keeps it in `config.yaml`, which the compiler owns), and an approval history beyond
  the current connection.
- **Routines and Telegram** need Hermes's messaging gateway for that home. The
  supervised gateway is the home's owner anyway (below), so routines and Telegram run
  in it. The owner's Telegram chat goes through AgentPier's own channel layer into the
  agent's session, as for OpenClaw (AGENTPIER-337). An agent's own bot for other
  people (`channelBots`, AGENTPIER-341) runs on Hermes's own Telegram adapter in that
  agent's gateway, its bot token alone, never the owner's bot, so each bot has one
  poller; voice notes go to an AgentPier Deepgram plugin. Hermes must never start a
  gateway of its own (the spike observed a detached, self-started one). As built
  (AGENTPIER-335): the routines sub-port drives that
  gateway's cron through the REST routes it hosts, which the RPC bridge calls with a
  one-request ticket from the control socket, and delivers each run's result to
  AgentPier's completion webhook itself ([routines](../hermes-runtime.md#routines)).
  AGENTPIER-342 added the parity: routines in another time zone run as pinned jobs,
  a result is written into its chat's history as a note through the bridge
  (`agentpier.note`), and Hermes work blocks a Hermes update as OpenClaw's blocks its
  own. Dangerous commands stay refused in routine runs on approval levels: Hermes's
  cron has no one to ask (`approvals.cron_mode` is deny or approve).
- **Host as built (AGENTPIER-329):** Hermes lets one process own a `HERMES_HOME`
  (`gateway.lock`), and `python -m tui_gateway.entry` refuses a home a gateway owns.
  Each Hermes agent therefore runs `hermes gateway run --external-supervisor` in the
  foreground as the home's owner (routines, channels and sessions) and a small
  AgentPier bridge (`runtimes/hermes/hermes-rpc-bridge.py`) that only discovers that
  owner, takes a session ticket from its owner-only control socket and relays its TUI
  JSON-RPC WebSocket (the same newline-delimited protocol as stdio) over stdin and
  stdout. AgentPier itself opens no listener; the gateway's loopback listener and
  control socket are reachable by the agent's own shell, as the spike found. The
  self-started gateway came from Hermes clients (`hermes cron run`, `hermes chat`,
  session and Kanban commands) that find no owner: `ensure_gateway_runtime` then
  starts one with `--idle-exit`, on macOS as a one-off launchd job through
  `osascript`. Hermes has no setting that turns this off; it cannot happen while
  AgentPier's gateway owns the home (clients attach to it), `--external-supervisor`
  makes `/restart` and `hermes update` exit back to AgentPier instead of starting a
  detached replacement, and the supervisor ends a gateway that owns the home before
  each start and after each stop (`hermes-supervisor.js`).
- **Team tools** reach Hermes through a small Python profile plugin that also carries
  the tool guard's `pre_tool_call` checks. The first plan named MCP tools; an MCP call
  carries no session or tool call id, while a plugin tool's handler receives the
  calling session, which the team bridge binds every call to. Waits longer than
  Hermes's 30-second hook timeout stay inside tools
  ([teams on Hermes](../hermes-runtime.md#teams)).
- **Browser:** AgentPier starts each Hermes agent's Chromium and passes
  `browser.cdp_url`, so live view and takeover use AgentPier's own CDP screencast.
  Verified against v0.22.5: a CDP URL never launches Hermes's own browser; its browser
  tools need the agent-browser binary, which the Hermes installation provisions
  ([browser on Hermes](../hermes-runtime.md#browser)).
- **Models:** AgentPier injects connection keys through Hermes's secret source; Hermes
  never adopts logins it finds on the host.
- **Logins (decided 2026-11-02):** account logins are runtime-neutral and AgentPier's:
  one login per account, never one per agent. AgentPier holds and is the only
  refresher of ChatGPT/Codex and MCP OAuth tokens; no refresh token is ever shared
  between two refreshers. OpenClaw gets an access-only ChatGPT profile in its own store
  (it never refreshes one without a refresh token and keeps every ChatGPT feature);
  Hermes reaches ChatGPT, and both runtimes reach OAuth MCP servers, through
  AgentPier's loopback proxy with a per-scope credential. Hermes never depends on a
  running OpenClaw. Logins OpenClaw made before keep working until the owner moves
  them explicitly (ChatGPT: **Move this ChatGPT login to AgentPier**; MCP: **Log in
  again**); nothing migrates on its own
  ([model connections](../assistant-model-connections.md#chatgpt-logins-held-by-agentpier),
  [MCP](../mcp.md#oauth-logins-held-by-agentpier)).
- **Toolchain:** Python 3.14 and `uv` are provisioned by the installation scripts and the
  update path, pinned like the OpenClaw runtime lock. Hermes is pinned to a release
  tag and the commit it names (the owner chose release `v0.22.5`, commit `bf0203a7`,
  on 2026-11-01, over the `main` commit `a4994d4e` of the spike). Hermes has no
  downgrade path: rollback restores the snapshot taken before an update.

### 5. Practical defaults for Hermes agents from the start

- Shell mode **approval** uses Hermes's own model: dangerous commands ask the owner,
  everything else runs. **Every-command approval** is an additional, stricter option,
  implemented by an AgentPier plugin returning `approve` from `pre_tool_call` with the
  command in its message. **Full** runs without asking, as today.
- Hermes may use **invisible subagents** (`delegate_task`) for its own work. Their
  approvals reach the owner like the parent's; they are not auto-denied.
- AgentPier turns off only what touches credentials, data leaving the host without the
  owner's choice, or the first-turn prompt: `adopt_external_logins`,
  `web.keyless_fallback`, onboarding hints.

## Delivery order

1. Introduce the port with OpenClaw as its only adapter and the shrinking-allowlist
   test; move the callers port by port. No behaviour change.
2. Runtime-neutral desired state; move `openclaw-config/` into the adapter.
3. `runtime` field on agents, capability-driven UI, runtime name in product copy (both
   catalogs).
4. Hermes host (install, supervise, update, snapshot rollback), sessions, events,
   approvals.
5. Hermes routines, memory, skills, MCP, models, Telegram.
6. Hermes teams and browser.

Each step ships with its contract tests against a pinned runtime, as OpenClaw does today.

## Considered options

- **One multiplexed Hermes process for all agents:** less memory, but MCP servers and the
  terminal environment are shared across agents, and one failure stops every agent.
- **Hermes's OpenAI-compatible API server or ACP as the control channel:** both lack
  configuration, routines and memory administration (`admin_config_rw`, `jobs_admin` and
  `memory_write_api` are `false`); the dashboard REST API has them but serves a token to
  any local peer when run on its own.
- **Replace OpenClaw instead of running both:** discards qualified behaviour and forces a
  migration of every agent at once.
- **Lock Hermes down first:** rejected by the owner; it repeats OpenClaw's history.

## Consequences

- Two runtimes double requalification work on version bumps; Hermes releases often.
- AgentPier gains a Python toolchain next to Node.js.
- Some features differ by runtime; the capability model makes that visible.
- The port and the neutral model also make OpenClaw upgrades cheaper to review.

## Open questions

- ~~Messaging gateway per Hermes agent versus AgentPier scheduling and Telegram
  delivery.~~ Answered in decision 4: the supervised gateway owns each agent's home
  and serves its sessions, so routines and Telegram run there.
- ~~Which Hermes command starts a detached gateway, and the setting that prevents
  it.~~ Answered in decision 4 (host as built): clients without an owner; no setting,
  the supervised owner prevents it.
- Linux behaviour and real Telegram. A real ChatGPT account on an access-only
  OpenClaw profile (chat, image_generate, transcription, realtime, usage, embeddings)
  and whether OpenClaw clears a 401 or usage cooldown when AgentPier writes a new
  token are still to be verified with the owner. (The browser CDP
  handoff is answered in decision 4: Hermes attaches to AgentPier's Chromium.)
- Moving an agent between runtimes, including history and memory.
