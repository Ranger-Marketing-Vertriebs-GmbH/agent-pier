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
entries; Hermes `config.yaml`, `.env` and plugin folders). Keys a runtime writes itself
(Hermes writes `onboarding.seen.*`, `_config_version` and gateway flags) are runtime
state: the compiler preserves them and never produces duplicate keys.

### 4. Hermes adapter shape

- **One Hermes process per agent**, each with its own `HERMES_HOME` inside AgentPier's
  private runtime folder. This avoids Hermes's process-wide MCP registration and
  terminal environment in multiplexed mode, at about 150–180 MB per agent (spike).
- **Control over stdio JSON-RPC** (`python -m tui_gateway.entry`) of a process the
  supervisor starts. No network listener and no control-socket ticket a process of the
  agent could use. Approvals, clarify and secret questions arrive as requests from
  Hermes and are answered by AgentPier.
- **Routines and Telegram** need Hermes's messaging gateway for that home. The adapter
  either runs it supervised next to the stdio process and attaches through the gateway
  listener, or schedules through AgentPier; the first implementation decides with a
  measurement. Hermes must never start a gateway of its own (the spike observed a
  detached, self-started one).
- **Team tools** reach Hermes as MCP tools (`team-mcp.js`), with a small Python plugin
  for the tool guard's `pre_tool_call` checks. Waits longer than Hermes's 30-second hook
  timeout stay inside tools.
- **Browser:** AgentPier starts each Hermes agent's Chromium and passes
  `browser.cdp_url`, so live view and takeover use AgentPier's own CDP screencast.
- **Models:** AgentPier injects connection keys through Hermes's secret source; Hermes
  never adopts logins it finds on the host.
- **Toolchain:** Python 3.14 and `uv` are provisioned by the installation scripts and the
  update path, pinned like the OpenClaw runtime lock. Hermes has no downgrade path:
  rollback restores the snapshot taken before an update.

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

- Messaging gateway per Hermes agent versus AgentPier scheduling and Telegram delivery.
- Which Hermes command starts a detached gateway, and the setting that prevents it.
- Linux behaviour, real Telegram, Codex subscription login and browser CDP handoff.
- Moving an agent between runtimes, including history and memory.
