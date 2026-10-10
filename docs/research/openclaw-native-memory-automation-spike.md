# Native memory and automation spike

Throwaway probe of 2026-10-08, moved out of the
[operating guide](../assistant-gateway.md#managed-native-memory-and-reminders-2026-10-08). The
integration it led to is described there; the open items below were superseded by the
implementation and the [release qualification](../assistant-release-qualification.md).

The owner requested reuse of OpenClaw capabilities rather than building parallel
memory or scheduling systems. A throwaway probe used the pinned 2026.9.8 runtime,
isolated state, synthetic data and the existing ChatGPT account. It did not start
the personal Telegram poller or send personal Telegram messages.

### Verified behavior

- The real agent used the native file tool to write a synthetic fact to
  `memory/home-network.md` in its own workspace.
- After a Gateway restart, native `memory_search` found the saved note. A newly
  created conversation then answered with the saved fact, without receiving that
  fact in its prompt. Search used `memory.search.provider: "none"`, the built-in
  keyword index, with transcript indexing and cross-conversation recall disabled.
  No embedding service or new memory database was implemented in AgentPier.
- The same native search in another agent's workspace returned no matching fact.
- A one-shot job created through `cron.add` survived a Gateway restart before its
  due time. OpenClaw's scheduler ran the real model and posted the result to a
  bearer-authenticated loopback webhook. Native run history recorded execution
  `ok`, completion `succeeded` and delivery `delivered`.
- A small throwaway receiver enqueued the result into the existing ChannelOutbox,
  keyed by native job ID and `runAtMs`. The existing Telegram sender made one
  acknowledged call to a simulated transport. Replaying the identical webhook
  did not create another notification or send. Restarting the Gateway after
  completion did not rerun the job or resend its result.

The receiver's HTTP acknowledgement means AgentPier durably accepted the result;
it does not itself mean Telegram accepted it. The existing outbox owns that second
delivery status. No claim of universal exactly-once network delivery follows from
the successful acknowledgement and duplicate-event tests.

### Integration requirements recorded by the spike

This list records the original spike findings. Subsequent implementation and
[release qualification](../assistant-release-qualification.md) supersede its open
memory, scheduler and delivery items; external services remain deferred.

1. Make native memory and automations deliberate managed capabilities.
   `prepareRuntimeConfig` currently forces memory off, starts with cron disabled,
   and restricts tools; profile application separately restricts per-agent tools.
   The probe changed these only in disposable configuration hooks. The upstream
   config API requires explicit `replacePaths` when intentionally reducing a
   tool-allow array; a naive replacement was rejected during the probe.
2. Expose OpenClaw's memory configuration, files, search and supported deletion
   controls through AgentPier. Start with per-agent workspace ownership and
   explicit memory tools. Semantic embeddings, automatic consolidation, trusted
   cross-conversation recall and full deletion/re-ingestion behavior were not
   qualified here. The probe's memory provenance reported an unknown session
   kind; classify AgentPier-origin sessions before enabling features that rely on
   native private-session provenance.
3. Project native automation jobs, state and history into AgentPier. Use the
   native create/update/remove interfaces, not a second schedule store or clock.
   Conversational job creation, recurring schedules, DST, missed-run policy,
   cancellation and agent/team authorization still need product-level tests.
4. Connect native completion webhooks to the existing durable channel outbox.
   The server must bind each job to its authorized agent and original channel
   destination, validate incoming events and use a stable native run identity.
   Model-produced text must not choose a recipient. Restrict the upstream webhook
   exception to the exact local receiver and keep its token private. Surface both
   native execution/transfer status and AgentPier's final channel delivery status.

Native references bundled with the pinned runtime are `concepts/memory.md`,
`concepts/memory-search.md`, `reference/memory-config.md`, and
`automation/cron-jobs/{managing-jobs,delivery}.md`. Online counterparts:
[memory](https://docs.openclaw.ai/concepts/memory),
[search](https://docs.openclaw.ai/concepts/memory-search),
[automations](https://docs.openclaw.ai/automation/cron-jobs), and
[webhook delivery](https://docs.openclaw.ai/automation/cron-jobs/delivery).

The spike itself did not activate personal capabilities. The managed slice that
followed is described under
[Managed native memory and reminders](../assistant-gateway.md#managed-native-memory-and-reminders-2026-10-08);
heartbeat remains disabled.
