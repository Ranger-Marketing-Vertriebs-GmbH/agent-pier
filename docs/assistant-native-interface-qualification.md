# Native interface qualification

The opt-in native interfaces contract checks the OpenClaw 2026.9.8 Gateway methods
and events that the layered configuration, exec approvals and channel pairing build
on. It runs a real isolated Gateway started by `RuntimeSupervisor` with AgentPier's
generated configuration, and the deterministic HTTP model from
`tests/helpers/assistant-model-server.js`. No model account, channel or credential
is involved.

## Running the contract

Point the environment variable at an installed, immutable runtime directory:

```sh
AGENTPIER_NATIVE_INTERFACES_CONTRACT_RUNTIME=/absolute/path/to/2026.9.8-node26.7.0-darwin-arm64 \
  node --test tests/integration/assistant-native-interfaces-contract.test.js
```

`scripts/provision-assistant-contracts.mjs` exports the variable together with the
other contract runtimes, and the `native-contracts` CI job runs the file. Each test
creates its own temporary data directory, loopback port and Gateway process, and
removes them afterwards. Ordinary `npm test` skips both tests unless the variable is
set.

## Result

On 2026-10-11, both tests passed on macOS arm64 (Darwin 25.5) against the pinned
`2026.9.8-node26.7.0-darwin-arm64` runtime, with zero skips or failures. The local
TAP output was kept outside the repository; temporary native state was removed
after completion.

## Covered behavior

**Locked core.** After start, `config.get` shows `gateway.terminal.enabled: false`
and `gateway.controlUi.enabled: false`.

**Hello features.** `hello-ok.features` has `methods` (470 names), `events` (64
names) and `capabilities`. The contract requires `config.get`, `config.schema`,
`config.schema.lookup`, `config.patch`, `channels.pairing.list`,
`channels.pairing.approve`, `channels.pairing.dismiss`, `exec.approvals.get`,
`exec.approval.list`, `exec.approval.get`, `exec.approval.resolve`, and the events
`exec.approval.requested` and `exec.approval.resolved`. `config.changed` arrives
as an event although it is not listed.

**Web login.** `web.login.start` and `web.login.wait` are not advertised: OpenClaw
deliberately leaves them out of discovery. Without a QR-capable channel plugin,
`web.login.start {}` answers `INVALID_REQUEST`. So the advertised list cannot gate
web login; the channel plugin's presence must.

**Schema.** `config.schema` returns `{ schema, uiHints, version, generatedAt }`
with `version: "2026.9.8"`. `config.schema.lookup { path }` returns
`{ path, schema, reloadKind, hint, hintPath, children }`.
`agents.defaults.timeoutSeconds` reports `reloadKind: "hot"` and
`gateway.port` reports `reloadKind: "restart"` with
`hint.label: "Gateway Port"`.

**Patches.** `config.patch { baseHash, raw, replacePaths }` returns
`{ ok, path, hash, config, changedPaths, sentinel }`. Shrinking
`agents.entries.main.tools.allow` without that exact path in `replacePaths` is
rejected with `INVALID_REQUEST`; with it, the array is replaced. A stale
`baseHash` is rejected with the generic `INVALID_REQUEST` and the message
`config changed since last load; re-run config.get and retry`; there is no
dedicated code. `patchConfig` therefore re-reads the hash after an
`INVALID_REQUEST` and reports `409 conflict` only when it changed. The contract
proves this with a write that lands between the helper's read and its patch.

**Exec approvals.** With `tools.exec.mode: "ask"` and `exec` allowed, the
deterministic model calls `exec` with `touch <marker>`:

- Without any client declaring an approval cap, OpenClaw has no approval route and
  denies the call inline; the tool result starts with `exec denied: Headless runs
cannot wait for interactive exec approval.` This was observed before
  AGENTPIER-25. Since then AgentPier's own client declares `exec-approvals` (see
  [shell qualification](assistant-shell-qualification.md)), so requests wait for a
  decision; the contract asserts that AgentPier's client receives them.
- A client declaring the handshake cap `exec-approvals` (or `approvals`) with
  `operator.admin` or `operator.approvals` is an approval route. It receives
  `exec.approval.requested` with
  `{ approvalKind: "exec", id, request, createdAtMs, expiresAtMs }` (30 minutes).
  `request` carries `command`, `cwd`, `host: "gateway"`, `security: "allowlist"`,
  `ask: "on-miss"`, `commandAnalysis`, `allowedDecisions`
  (`["allow-once", "allow-always", "deny"]`), `agentId`, `resolvedPath`,
  `sessionKey` (the session is under `request`, not at the payload top level),
  `runId`, `toolCallId` and `turnSourceChannel: "webchat"`.
- `exec.approval.get { id }` returns `id`, `commandText`, `commandPreview`,
  `allowedDecisions`, `host`, `nodeId`, `agentId` and `expiresAtMs`, and
  `exec.approval.list {}` returns the pending entries.
- `exec.approval.resolve { id, decision: "deny" }` returns `{ ok: true }`.
  `exec.approval.resolved` carries `id`, `decision: "deny"`, `resolvedBy`, `ts`
  and `request`. The tool result reads `Exec denied (gateway id=<id>, user-denied)`,
  and the marker file never exists.

The approval event names its session under `request.sessionKey`, so `GatewayEventHub` dispatches events
by name and skips only `chat` frames.

**Pairing.** `channels.pairing.list {}` answers with the operator scopes AgentPier
requests (`operator.admin`, `operator.read`, `operator.write`) with empty
`accounts` and `requests`, `commandOwnerConfigured: false` and
`limits: { pendingPerAccount: 3, ttlMs: 3600000 }`. Naming a channel that is
not installed (`{ channel: "whatsapp" }`) answers `INVALID_REQUEST`.

## Boundaries

A WhatsApp login is not exercised until the WhatsApp plugin is part of the
runtime lock. Pairing requests are only listed, not created, approved or
dismissed. The exec approval test denies; it does not allow, and it does not
cover `allow-always` grants, node hosts or `exec.approvals.set`. The exec
configuration is test-only and bypasses `prepareRuntimeConfig`; AgentPier's
locked core keeps `exec` off. AgentPier's own Gateway client still declares no
caps, so a product approval flow needs the `exec-approvals` cap. The deterministic
model proves plumbing, not model behavior.
