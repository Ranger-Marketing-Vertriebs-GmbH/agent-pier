# Assistant team qualification log

Chronological evidence from the visible-team work on 2026-10-08, moved out of the
[operating guide](../assistant-gateway.md#visible-teams-operation-and-recovery). It records what was tested
and observed at that time with disposable or owner-approved state. Current behavior is
described in the guide and may have moved on since; where a later review changed it,
the guide and [release qualification](../assistant-release-qualification.md) prevail.

## Team qualification (2026-10-08)

Run `node scripts/verify-assistant-teams.mjs --data-dir <new-absolute-disposable-dir>`.
The command rejects existing application data, creates a qualification marker,
installs the pinned runtime through its normal installer, and removes its owned
runtime/data on completion. Deterministic HTTP models and a simulated Telegram
transport exercise the actual product plugin, bridge, coordinator and request ledger.

Verified locally on macOS arm64:

- Fresh installation; four member model calls simultaneously held at a barrier;
  independent override and promotion; one parent synthesis and one late Telegram
  result after the original inbox entry was delivered.
- Ask-first and standing permission through actual model tool calls; existing-runtime
  repair of a missing plugin asset; exact history after graceful restart.
- Active Gateway crash retained four uncertain member reservations without replay.
- OpenRouter `google/gemini-3.8-flash` actually selected the team tool, completed four
  members and synthesized the result. Its disposable provider data was removed.
- Focused tests cover delayed invocation retirement, lost create/send acknowledgements,
  policy revocation during admission, source-bound callbacks, outbox restart,
  revision conflicts, Unicode chunking and retained UI drafts.

Linux and other native architectures still require equivalent runtime qualification.
The existing personal Telegram/Deepgram trial was not restarted or used for synthetic
team messages. This work remains on `feat/assistants`; no main integration or release
is implied. A full transactional runtime upgrader, service adapters, coding delegation
and sandbox policy remain separate work.

## Team review and refinements

The independent review found four important edge cases: missing terminal text,
stale form revisions, inaccessible setup recovery and incomplete Telegram proposal
details. Regression coverage exercises each correction, including full-size Unicode
proposals and approval buttons on the final acknowledged chunk. Policy and host
settings drafts retain the revision they were opened with; a concurrent update
requires reloading instead of silently restoring stale permission values.

The three UI review refinements are implemented. Historical members are grouped by
assignment in a bounded sidebar scroll area, with task hints and direct chat access.
Agent settings identify model and instruction differences from the creation snapshot
separately; later parent edits do not affect that comparison, and restoring the
original value clears its changed indicator. Only the comparison booleans are
exposed, not the private snapshot.

The derived team `status` distinguishes stopping, uncertain and partial success;
uncertainty takes precedence over stopping, and a mixture of successful and failed
or cancelled members is partially successful. Durable `phase` still controls
admission, archival and recovery. These presentation refinements do not release
uncertain reservations or alter execution outcomes.

The review relies on the captured real-provider evidence; it did not send fresh
personal Telegram messages. Other architectures remain a qualification gate. Service
adapters, coding delegation, OS sandbox policy and the transactional updater remain
outside this team slice. During implementation the application wiring moved from
the plugin task to the coordinator task so tools were never advertised before their
service existed.

## Team-enabled worktree trial (2026-10-08)

After the owner's explicit approval, the existing private Telegram trial was moved
to backend revision `0788c023` in the assistants worktree. The old process stopped
with no pending inputs or attempts, and a private offline backup was taken first.
The current backend uses its normal pinned runtime installer in the trial data
directory; the earlier qualification-runtime override is no longer needed.

Existing assistant/conversation identities, request history, Telegram pairing and
Deepgram configuration were retained. The existing ChatGPT account probe passed;
OpenClaw 2026.9.8 reports ready/current, the managed team bridge is ready and the
parent profile has its team tools applied. Its obsolete status-only instruction
was replaced with the available team workflow. Team autonomy remains ask-first.

The owner then requested a four-member home-network dashboard planning team through
Telegram and approved the delivered proposal. All four members were admitted within
40 milliseconds and completed successfully using the retained ChatGPT account.
The parent synthesis failed with OpenClaw's `CodexThreadPolicyHandoffError`: Codex
did not acknowledge unloading the preceding configuration before the conversation
resumed. Telegram received the fallback with the individual reports. Successful
ChatGPT synthesis after team execution remains unqualified; the failed attempt was
not automatically retried and its conversation was preserved.

The trial exposed missing feedback after approval. Telegram callbacks now display
the actual decision outcome, including a stale-decision notice for repeated clicks.
The source-bound durable outbox also sends one decision confirmation and one start
notice when members are observed running, with the current running/total count.
Provisioning and uncertain members do not produce a claim of active work. Transfer
records prevent duplicates; a crash between outbox insertion and transfer bookkeeping
reuses the original notification. Already transferred results receive no retrospective
approval or start messages. These additions use paired German/English catalogs.

Main and the installed AgentPier release remain unchanged.

## Explicit ChatGPT assistant runtime (2026-10-08)

ChatGPT-backed assistant profiles now explicitly select OpenClaw's agent runtime
for the chosen `openai/<model>` entry. The exact OAuth profile remains bound in
the model reference. AgentPier does not copy the credential into provider config,
change the selected model, or replace the conversation. Other model-entry fields
are preserved and the effective runtime policy is read back before configuration
is considered applied. This applies through ordinary profile configuration on
both new and existing installations.

This is a supported compatibility mitigation for the native Codex policy-handoff
failure observed in the owner trial, not a patch to Codex or OpenClaw internals.
Implicit selection previously depended on whether the Codex plugin was installed;
fresh-state probes could therefore exercise a different execution path. The native
adapter assumes configuration unload during handoff, while Codex's documented
`thread/unsubscribe` keeps the thread loaded during an inactivity grace period.
The original failure was not reproduced by every native four-member probe and is
not claimed fixed upstream. See [Codex unsubscribe semantics](https://learn.chatgpt.com/docs/app-server#unsubscribe-from-a-loaded-thread)
and the pinned OpenClaw documentation `providers/openai/runtimes.md` for explicit
`agentRuntime.id: "openclaw"` with a selected OAuth profile.

Disposable macOS qualification with the actual ChatGPT account verified:

- A native Codex conversation continued under the explicit OpenClaw runtime and
  recalled a synthetic phrase from before the switch.
- With the Codex plugin installed, the product-created parent and four concurrent
  members completed, followed by the parent synthesis under the explicit runtime.
- The exact synthesis remained available after a Gateway restart.

The probes used separate state, synthetic messages and no personal Telegram sends.
Native coding-session routing is independent of this assistant policy.

## Telegram approval reply ownership (2026-10-08)

The owner's next Telegram trial completed all three team members and the parent
synthesis under the explicit OpenClaw runtime. Approval, decision, work-start and
result notifications were acknowledged by Telegram. It also exposed duplicate
approval prompts: the structured proposal with buttons was followed by the parent
model's final prose, sometimes after the owner had already approved the team.

For a Telegram turn that produces an approval proposal, the structured proposal
now owns the Telegram reply. Correlation uses the original attempt, conversation
and paired destination, regardless of whether the team has already been approved
or declined. The original model prose remains in conversation history. Ordinary
replies from other turns and team progress/results retain their own delivery.
Long proposals still use Telegram's existing message chunking, with the buttons
on the final chunk.

The input settles only after its approval notifications are acknowledged or
explicitly reviewed. Failed or uncertain delivery remains recoverable through the
notification queue; it never falls back to sending a second plain-text approval.
Persisted acknowledgements survive worker reconstruction. A completed model turn
waiting on approval delivery no longer advertises ongoing typing.
