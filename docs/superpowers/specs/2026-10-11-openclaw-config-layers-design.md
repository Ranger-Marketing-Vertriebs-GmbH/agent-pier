# Layered OpenClaw configuration and native interface verification

Status: agreed design. Plane: AGENTPIER-23 (step 1 of AGENTPIER-21).

Date: 2026-10-11

Umbrella design: `2026-10-11-openclaw-native-capabilities-design.md` (branch
`docs/openclaw-native-capabilities`).

## Goal

Build the foundation for exposing native OpenClaw capabilities: AgentPier computes
the whole OpenClaw configuration from stored inputs in three layers, enforces a
locked core on every start and every live change, receives more Gateway events, and
verifies the native interfaces later steps rely on against the pinned OpenClaw
2026.9.8.

This step changes no visible behaviour. Existing tests, including the team contract
and qualification tests, must pass unchanged.

## Current state

- `prepareRuntimeConfig` (`server/features/assistants/runtime-config.js`) writes
  `openclaw.json` before each Gateway launch. Hardening defaults (`channels: {}`,
  `browser.enabled: false`, discovery off, telemetry off, updates off,
  `skills.allowBundled: []`, heartbeat `0m`) are written **only when no file
  exists**; later starts keep whatever the file holds. Other keys (`tools`,
  `plugins`, `cron.enabled`, `agents.defaults.skills`, logging, diagnostics, most of
  `gateway`) are forced on every start.
- Live changes call `config.get` and `config.patch` directly from several modules:
  provider entries and per-agent `tools.allow`, `memory.search` and
  `models.<m>.agentRuntime` in `assistant-config.js`, `cron.enabled` in
  `assistant-maintenance.js`. Agent roster changes use `agents.create` and
  `agents.update`; `AGENTS.md` uses `agents.files.*`.
- `AssistantProviderSynchronization.prepare()` rewrites `models.providers` and each
  entry's `model` in the file before launch.
- On a fresh start the write guard is unproven, so the start removes guarded write
  tools from every agent; after the guard is proven, a live apply grants them. This
  difference is intended, but it is implicit.
- The Gateway client emits every frame as an event; only `assistant-service.js`
  consumes them, and it handles only `chat` for sessions. The hello frame's
  advertised methods and events are discarded.

## Design

### Configuration compiler

A pure function computes the full configuration:

```
compileOpenClawConfig({ base, overrides, profiles, core, runtime }) -> config
```

- `base`: the existing file, or the fresh defaults when none exists.
- `overrides`: owner overrides (layer 3); empty until step 9.
- `profiles`: per-agent settings (layer 2), derived in this step from today's
  assistant capabilities (memory, reminders), team profiles and model leases.
- `core`: the locked core (layer 1), computed from installation paths, port, token,
  TLS, team plugin connection and host capacity.
- `runtime`: explicit runtime state that legitimately changes the result:
  `guardProven` (write guard proven by this Gateway) and `maintenance`.

Order: base, then overrides (locked paths removed), then profiles, then the core.
The core is applied last, so no other layer can change a locked path.

`prepareRuntimeConfig` becomes a thin caller that compiles and writes the file with
`runtime.guardProven = false`. Its output for today's inputs equals the current
output plus the enforced core; characterisation tests pin this before the refactor.

### Locked core

An explicit, tested list of paths and values owned by AgentPier:

- `gateway`: mode, bind, port, auth, TLS, `controlUi.enabled: false`,
  `terminal.enabled: false`, tailscale off, reload mode.
- `update` (no checks, no auto-update), `discovery`, `telemetry`, `diagnostics`,
  `logging`.
- `plugins`: allow list, load paths, slots and entries for `agentpier-teams` and
  `memory-core`; plugin install sources stay closed.
- `agents.defaults.workspace`, `agents.defaults.skills`,
  `agents.defaults.maxConcurrent`, `agents.defaults.heartbeat`.
- The team and memory tools inside each agent's tool list, and `tools.toolSearch`.
- `cron.enabled` and the cron webhook.
- Until their steps open them: `channels`, `browser.enabled`, `skills.allowBundled`,
  `skills.workshop.autonomous.mode`, `memory` dreaming and cross-conversation
  recall.

The hardening defaults that are written only on first start today are enforced on
every start. A later step that opens a capability moves its paths from the core to a
profile, together with that step's safety rule.

### Live synchronisation

One module applies configuration changes to a running Gateway:

1. `config.get` returns the current config and hash.
2. Compile the target with the current inputs and `runtime.guardProven` from the
   Gateway's state.
3. Patch the difference with `config.patch` and `baseHash`; paths AgentPier manages
   completely go in `replacePaths`.
4. Read back and compare the managed paths; a mismatch is a conflict (HTTP 409, as
   today).

`assistant-config.js` (agent entry tools, memory search, agent runtime, provider
entries, `maxConcurrent`) and `assistant-maintenance.js` (`cron.enabled`) switch to
this module. `agents.create`, `agents.update` and `agents.files.*` stay as they are;
they are not configuration writes. A start and a live apply with the same inputs and
runtime state produce the same managed paths; a test pins this.

### Storage

- Profiles in this step are derived from existing assistant records; no new fields.
- Overrides get their own table (owner-scoped, revisioned) and a validator that
  rejects locked paths. There is no UI or HTTP route yet.

### Gateway events

- The Gateway client records the hello's advertised methods and events. A missing
  method that a capability needs becomes an explicit "unavailable" state instead of
  a failed call.
- A separate event hub subscribes when the runtime becomes ready and dispatches
  non-session events by name to registered handlers. The chat handler stays as it
  is.
- After every (re)connect, handlers resynchronise state that events may have missed
  (for example pending approvals), because events during a disconnect are lost.
- Handlers for exec approvals, pairing requests and channel status are registered
  by steps 3 and 4. This step only provides the hub and the verified event names.

### Live verification

A new contract test runs against a real isolated OpenClaw 2026.9.8, provisioned like
the existing contracts (`scripts/provision-assistant-contracts.mjs`), with the
deterministic model server:

- `config.schema` returns a schema with UI hints; `config.schema.lookup` reports the
  restart requirement for a hot path and a restart path.
- `config.patch` with `baseHash` and `replacePaths` replaces a managed path; a stale
  hash is rejected.
- Exec approvals: with `tools.exec.mode: ask`, a model tool call for `exec` produces
  an approval request event; its name, payload and the approve and deny methods are
  recorded; a denied command does not run.
- `channels.pairing.list` answers with the required scope.
- `web.login.start` is advertised (a full WhatsApp login waits for step 5, when the
  plugin is in the runtime lock).
- The locked core holds on a running Gateway: after start, `config.get` shows the
  terminal and the Control UI off.

The test joins the file list in `.github/workflows/assistant-runtime.yml`. Results go
into a new `docs/assistant-native-interface-qualification.md` and a row in
`docs/assistant-release-qualification.md`. `docs/adr/0002-managed-openclaw-assistants.md`
gains coupling rows for `config.schema`, `config.patch` with `replacePaths`, the
exec approval methods and events, `channels.pairing`, `web.login`, the extended
event list and scopes, and the locked-path list.

## Teams

- The team plugin, its connection and the team tools belong to the core.
- The write guard rule is an explicit runtime input: guarded tools are granted only
  when `guardProven` is true, as today.
- Cron stays off during maintenance and on only in native team mode, as today.
- The team contract and qualification tests run unchanged and must pass.

## Testing

- Characterisation tests of today's generated configuration for representative
  inputs (no teams, teams, native teams, maintenance, existing file with drift).
- Unit tests of the compiler: layer order, locked paths win, overrides cannot touch
  locked paths, drifted hardening defaults are restored.
- A test that a start and a live apply produce the same managed paths for the same
  inputs and runtime state.
- Unit tests of the event hub (dispatch by name, resync on reconnect, unavailable
  methods).
- The live contract described above.
- Existing assistant unit, integration and contract tests unchanged.

## Out of scope

UI, HTTP routes, capability profiles beyond today's capabilities, approval storage
and UI for exec or pairing, channel setup, and opening any locked capability.
