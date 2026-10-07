# OpenClaw status diagnostics and recovery spike

Date: 2026-10-07. Runtime: `openclaw@2026.9.8`, Node 26.7.0, macOS arm64.
Follow-up to the [permanent-agent spike](openclaw-permanent-agent-spike.md).

## Result

The observed `Subagent terminal signal owner changed before commit` warning is a
race between two completion callbacks for the same run. In the tested cases, the
stale callback was rejected and the current callback stored exactly one completion
event. It was not evidence of losing the conversation or its final run status.
This finding does not establish that all warnings with this text are harmless.

A separate process-crash probe exposed a recovery boundary: an interrupted run was
recognized as interrupted, but `agent.wait` did not provide a terminal receipt.
Resending the same request after restart started execution again under the same
run ID. AgentPier must distinguish reconciliation from retrying external effects.

## Reproduction and causal evidence

The deterministic local model created one hidden child and one persistent visible
child through real `sessions_spawn` calls. Both completed, received follow-up turns,
survived a graceful restart, and were inspected through `sessions.describe` and
`chat.history`. The operator connection was then dropped after accepting another
turn, reconnected, and the same request was sent with its original idempotency key.

There were three runs of this scenario: one unchanged baseline and two with
diagnostic-only instrumentation in the disposable runtime. Each produced five
completion warnings and five distinct persisted completion events. Read-only
inspection of the disposable SQLite signal store found no duplicate or missing
completion for those five runs. Both child types reported `done` with the expected
latest run ID, and retained their parent relationship after restart.

Instrumentation captured the guard conditions immediately before the warning:

| Condition                                            | Observed value |
| ---------------------------------------------------- | -------------- |
| Registry entry is still the same object              | true           |
| Run ID, child, requester and end timestamp unchanged | true           |
| Outcome reference and outcome value unchanged        | true           |
| A newer run owns the child session                   | false          |
| Session effects suppressed or yield pause active     | false          |
| Callback's captured terminal generation              | 1              |
| Current terminal generation                          | 2              |

Source-labelled traces identified the two completion callers as
`lifecycle-ok-event` and `subagent-wait`. In the pinned implementation,
`completeSubagentRunAttempt` increments the terminal generation while holding the
completion lock, releases that lock, then awaits `completeTerminalEffects`.
The second caller can therefore advance the generation before the first caller's
asynchronous signal write passes its commit-admission guard.

The rejected generation-1 write reaches the generic warning handler in
`recordSessionStateEventAsync`. The generation-2 callback completes the signal
write. This also explains why the warning occurred on first completion, before any
conversation reuse. The previous report's association with reused sessions was an
observation, not the root cause.

The probe changed only diagnostic output in the temporary package. It did not
bypass a guard or suppress a warning, and restored the original module after each
instrumented run. No production dependency or AgentPier product code was patched.

## Connection loss versus process loss

| Scenario                                                | Observed behavior                                                                | Integration consequence                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| WebSocket disconnect; Gateway continues running         | The run completed; reconnect plus `agent.wait` recovered its terminal result     | Reconcile by existing run ID before considering another send                              |
| Same request/idempotency key after reconnect            | Returned the same run ID and completed status; user message appeared once        | Confirmed deduplication in this process-lifetime scenario                                 |
| Graceful restart after completion                       | Chat history, parent relation and latest completed status remained available     | Restore UI from persisted sessions/history                                                |
| SIGKILL during a visible child's active model call      | Restarted child reported `subagentRunState: interrupted`, with no active run     | Show interruption explicitly; do not display stale running/success state                  |
| `agent.wait` for the interrupted run                    | Returned a wait timeout without terminal metadata                                | A wait timeout is not a task failure or completion receipt                                |
| Resend of the interrupted request with its original key | Returned `started` with the same run ID and executed again                       | Request deduplication is not a guarantee against repeated external effects across crashes |
| New task after recovery                                 | Completed in the existing child conversation; earlier transcript prefix survived | The persistent assistant remained usable                                                  |

The crash probe used a synthetic delayed model response, not a mail/calendar/shell
action. It demonstrates re-execution of a model turn, not an observed duplicate
real-world side effect. The adapter still needs per-action reconciliation and
service-specific idempotency before automating such retries.

Thirty-seven assertions passed across these four probes. All owned Gateway
processes and model servers were stopped. Raw probes, logs and read-only database
observations are retained in the private ignored spike cache; credentials and local
paths are excluded from this record.

## Recommended handling

- Do not turn a native warning directly into a failed task. Preserve the diagnostic
  and reconcile the run receipt, latest session state and history.
- Keep transport availability, conversation state, run outcome and action delivery
  separate. A completed model run does not prove a downstream message was delivered.
- Use an AgentPier-owned request ledger and run/session mappings. On reconnect,
  recover known work before retrying; after process loss, classify interrupted or
  uncertain operations explicitly.
- Treat this reproducible stale-callback diagnostic as an upstream issue suitable
  for a focused report. No report was posted and no runtime fork is proposed.
- Re-run these probes when changing the runtime pin. Retain missing-completion and
  duplicate-effect checks rather than matching or hiding one log string.

## Remaining limits

Not qualified: production-scale load, every callback interleaving, parent failure
with multiple active descendants, storage failure, a crash during an external side
effect, real channel delivery, automatic cross-Gateway delegation, and Linux.
The result supports a managed Gateway adapter; it is not release qualification.

## References

- [Gateway external-app integration](https://docs.openclaw.ai/gateway/external-apps)
- [Agent loop and terminal outcomes](https://docs.openclaw.ai/concepts/agent-loop)
- [Gateway design proposal](../assistant-gateway.md)
