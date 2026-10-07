# OpenClaw permanent-agent and multi-Gateway spike

Date: 2026-10-07. Tested npm `openclaw@2026.9.8`, Node 26.7.0, macOS arm64.
This is throwaway feasibility evidence, not a shipped AgentPier integration.

## Question and result

Can an assistant create lasting team members, and does each member require a
separate OpenClaw process? The tested runtime supports three different objects:

| Object                         | What persists                                                     | Creation path tested                                                      |
| ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Visible delegated conversation | Conversation, parent/creator relationship and history             | Actual model tool call to `sessions_spawn` with `visible: true`           |
| Agent profile                  | Named profile, workspace and model selection                      | Authenticated backend `agents.create` RPC, then delegation with `agentId` |
| Separate Gateway instance      | Independent process, configuration, credentials and session store | Two separately supervised foreground Gateway processes                    |

The first two fit inside one Gateway. A visible child conversation does not
automatically create a distinct profile. A profile can host multiple conversations.
Persistent means stored and available for later work; it does not mean the model
continuously generates tokens while idle.

## Probe and evidence

The existing disposable installation was reused. Each run had its own HOME,
configuration, state, workspace and explicit log path, with random test credentials.
The model was a deterministic local HTTP server emitting real streamed tool calls;
OpenClaw executed those tools and ran the resulting children. No personal accounts,
external channels, paid inference, production sessions or installed daemons were used.

The team probe performed these operations in order:

1. Start and authenticate to an empty Gateway; create `specialist` through
   `agents.create`, with its own workspace and model reference. The running Gateway
   hot-reloaded the additional profile.
2. Send separate parent tasks whose model responses call `sessions_spawn`, once
   with `visible: false` and once with `visible: true`, targeting `specialist`.
3. Observe accepted tool receipts with distinct child session keys and run IDs,
   actual child model calls, parent completion messages and terminal outcomes.
4. Inspect both children through `sessions.describe`, `sessions.list` and
   `chat.history`. The hidden child is classified as `subagent`; the visible child
   is classified as `direct`, is not background-only, and retains agent ownership.
5. Exercise rejected requests and cancel a third, actively running visible child.
6. Stop and restart the Gateway. Rediscover the profile and child relationships,
   compare complete message arrays, then send follow-up turns to the same hidden
   and visible session keys.

Both retained histories were exactly equal before and after restart. Follow-up
turns appended to the same transcripts. The `spawnedBy` and `parentSessionKey`
fields still identified the assigning parent. Parent histories contained the
children's completion result. Cancelling the third child returned `aborted`, and
`agent.wait` confirmed a terminal result with `stopReason: rpc`.

The multi-Gateway probe started two processes concurrently with different state,
configuration, workspace, token and loopback port assignments. Both answered model
requests and each listed only its own test session. Gateway B answered another
request while Gateway A was stopped. A restarted with its original history intact.
This verifies independent operation, not automatic delegation between Gateways.

Nineteen explicit assertions checked the resulting evidence, including persistence,
parent relationships, follow-up replies, negative cases, cancellation, parallel
operation and cleanup. All owned Gateway processes and model servers were stopped.
Throwaway probes and raw evidence remain in the private spike workspace; no runtime
credentials, local account data or host-specific paths are included in this record.

## Boundaries discovered

- `sessions_spawn` rejected an unknown `agentId` as absent from the configured
  registry. It selects a profile; it does not provision one.
- A model call requesting `mode: "session"` without a supported channel/thread
  context failed validation. `visible: true` with the default run mode still
  produced a persistent direct conversation. These are different mechanisms.
- The native `gateway` model tool rejected `action: "config.patch"`. Its tested
  schema permits config/schema reads and `update.run`; it is not the authenticated
  operator configuration API. The profile-creation RPC was called by the test
  controller, not autonomously by the model.
- A separate attempt to call `sessions_spawn` through `tools.invoke` returned
  `Tool not available`, despite availability inside the actual model run. The
  successful probes used model tool execution; this RPC is not a proven substitute.
- Tool search deferred the model-visible schemas by default. The deterministic
  tool-call probe explicitly used `tools.toolSearch: false`; production integration
  still needs capability testing with its chosen model and tool surface.
- Hidden children used `cleanup: "keep"` and auto-archive was disabled for the
  experiment. Their survival here does not establish indefinite retention under
  default cleanup settings. The visible path creates an ordinary persistent session.
- Reusing child sessions produced runtime diagnostics stating that a subagent
  terminal-signal owner changed before commit. Observed histories and replies were
  intact, but registry/event consistency needs further testing before release.

## Recommendation for AgentPier

Keep one managed Gateway per host as the initial topology. Offer task-bound team
members as well as lasting assistants, and represent profile identity separately
from conversation identity. Use existing profiles when appropriate; provision a
distinct profile when separate instructions, workspace or durable settings are
needed. Keep team membership and authorization provenance in AgentPier.

Expose a narrowly scoped AgentPier provisioning tool for an authorized assistant
to request a permanent colleague. Its backend can call `agents.create`, apply the
selected configuration and then delegate through `sessions_spawn`. This bridge is
a recommendation, not implemented or tested here. Enforce the agreed ask-first
default, per-assistant standing permission and explicit task authorization there.
Whether permanent provisioning requires an additional explicit user choice remains
a product decision; this spike does not silently broaden team authorization.

Treat separate Gateways as an optional later deployment mode for independent
lifecycle, configuration or failure handling. Their startup should remain owned by
AgentPier's supervisor. A standard spawn does not create a Gateway or establish a
cross-Gateway team. Shared host access is not an OS sandbox in either topology.

## Remaining qualification

Real-model planning and tool choice; autonomous profile-provisioning bridge; settings
snapshot/override behavior; missed/duplicated event reconciliation; parent failure;
abrupt crashes during active work; long-term retention; permissions and limits;
automatic cross-Gateway delegation; service accounts and background macOS permissions;
Linux installation and managed upgrades remain unverified.

## References

- [Subagent tool parameters](https://docs.openclaw.ai/tools/subagents/tool-reference)
- [Multi-agent routing and profiles](https://docs.openclaw.ai/concepts/multi-agent)
- [Multiple Gateways](https://docs.openclaw.ai/gateway/multiple-gateways)
- [Initial runtime spike](openclaw-runtime-spike.md)
- [Integration ADR](../adr/0002-managed-openclaw-assistants.md)

The package's bundled documentation and tool schemas were checked alongside the
live probes. Online documentation can change independently of the tested pin.
