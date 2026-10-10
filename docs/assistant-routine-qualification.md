# Native routine schedule qualification

AgentPier delegates schedule calculation, missed occurrences and run persistence
to OpenClaw. It does not maintain a second scheduler. This qualification targets
OpenClaw **2026.9.8**, its managed **Node 26.7.0**, and macOS arm64.

## Observed schedule policy

The pinned native implementation and executable tests establish these behaviors:

- Cron uses the supplied IANA timezone even when the host timezone is UTC.
  Berlin and New York daily schedules skip a wall-clock time that does not exist
  during the spring DST transition. During the autumn transition, they select
  the first occurrence of the repeated time and advance to the following day;
  the second occurrence does not produce another scheduled run.
- A one-shot timestamp identifies an absolute instant. An explicit numeric UTC
  offset is respected. The browser's local-time input conversion remains a
  separate UI boundary.
- By default, thirty days offline produce **one catch-up run per overdue job**,
  rather than one run per missed daily slot. The recurring job then advances to
  its next future scheduled occurrence. A process that stays running across a
  simulated thirty-day sleep also coalesces missed slots when its timer fires.
- On startup, overdue agent turns are deferred for **120 seconds**, with
  additional overdue agent jobs spaced **5 seconds** apart. Another scheduler
  restart before this deadline preserves the existing deferral. These are the
  pinned native defaults; readiness, admission limits and model latency can
  further delay execution.
- An overdue one-shot remains eligible after thirty days offline. Once completed,
  restarting does not run it again. A paused routine and a native-disabled event
  routine stay disabled across downtime.
- Native `cron.skipMissedJobs: true` drops recurring missed work and advances to
  the next future occurrence. It does **not** drop overdue one-shots. AgentPier
  does not expose this native option in its routine editor or set it by default.
- Replaying completed native events after reconstructing the reminder adapter
  produces one durable outbox entry per run. Processing that outbox again does
  not send another acknowledged Telegram message. A later scheduled occurrence
  still produces a new entry and message.

The pinned package documents missed-job behavior in
`docs/automation/cron-jobs/how-it-works.md` and
`docs/automation/cron-jobs/managing-jobs.md`. Exact timing can also include native
cron staggering: expressions with minute `0` and a wildcard hour receive a native
default window of up to five minutes. The qualification uses daily schedules
without that default staggering, and disables staggering explicitly for the
direct DST calculations. It does not assert that every accepted cron expression
has zero timing jitter.

## Reproduce safely

Point the existing opt-in variable at an already installed immutable runtime:

```sh
AGENTPIER_ASSISTANT_ROUTINE_RUNTIME="$PWD/.cache/assistant-openai-qualification/assistants/runtimes/2026.9.8-node26.7.0-darwin-arm64" \
  node --test tests/integration/assistant-schedule-qualification.test.js
```

The normal test suite skips this contract when the variable is absent. The test
launches the runtime's own Node executable, imports the pinned package's actual
schedule helpers and `CronService`, and gives it an injected clock and timer
driver. Advancing that clock does not wait thirty days or two minutes and does
not replace native schedule computation. The suite checks native persisted state
by creating fresh service instances against the same disposable store.

All writable state, HOME, configuration, channels and bindings are disposable.
The HTTP model and Telegram client are local fixtures. The native job execution
callback contacts the fixture model; completion events are fed directly to the
real AgentPier reminder adapter and durable outbox. No personal reminders,
provider credentials, real Telegram messages or user projects are used.

Nine native subtests cover both DST transitions in both regions, timezone and
absolute-time handling, restart catch-up, preserved startup deferral, normal
resumption, one-shot completion, skip policy, paused/event routines, staggered
backlogs and simulated host sleep. The wrapper reports their results. The
existing `assistant-routine-contract.test.js` separately exercises the real
gateway, generated model output and HTTP webhook boundary.

## Qualification limits

These tests recreate the native scheduler and reminder adapter from persisted
state. They do not kill an operating-system process during a model turn or
between a Telegram send and its acknowledgement. They do not establish
exactly-once external side effects in those ambiguous crash windows. The native
documentation describes interrupted-run receipt recovery, but that description
is not evidence of an executed crash test here.

The HTTP fixture proves scheduling integration, not model quality or live vendor
availability. Actual suspend/resume, clock rollback, timezone database updates,
all IANA zones, migrations between native versions and Linux/macOS cross-platform
parity require separate qualification. Pinned internal export filenames are
intentional: a runtime update must requalify these assumptions rather than
silently test a different implementation.
