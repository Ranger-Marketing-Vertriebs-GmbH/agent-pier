# Reference pipeline engine inventory

Read-only inspection on 2026-09-07 of the supplied `agent-runner-ce-main` archive,
extracted under `agentpier-pipeline-reference-8k00kxik`. No reference code, scripts,
installers, model requests, or existing native sessions were executed. Source paths
below are relative to that reference root, not AgentPier. Statements describe
executable branches; comments and unused types are not treated as working features.

## Executive contract

The reference is a **sequential, verdict-driven graph executor**, with one current
profile stage per run. It supports conditional routing, bounded repair loops,
human gates, verification commands, and one run pull request. It is not a parallel
DAG scheduler. The pipeline definition and CLI profiles are frozen into each run.
The UI can display a graph while runtime state consists of profile attempts plus
folded side-effect markers.

The profile vocabulary includes Claude, Codex, and OpenCode, but **Codex pipeline
execution is explicitly disabled** by `canDriveStage` and `startNode`. AgentPier's
three-CLI requirement therefore needs a new Codex adapter, not just reference UI
parity. Existing AgentPier terminal sessions should remain independent; pipeline
stages need their own explicitly owned execution sessions and launch profiles.

Sources: `packages/core/src/cliToolCapabilities.ts:17`,
`apps/server/src/pipelines/runStore.ts:85`, `orchestrator.ts:660`.

## Definition, snapshots, and graph semantics

- Definition nodes: `profile`, `gate`, `verify`, `createPr`. The `updateTicket`
  literal survives in types but graph validation rejects it; there is no Jira.
- Node IDs match `[A-Za-z0-9_-]{1,64}`. Entry must be a profile node. Every node
  must be reachable. Every edge references existing nodes, and each node has at
  most one outgoing edge per condition: `pass`, `fail`, or `default`.
- Side-effect nodes have exactly one inbound edge, never a fail inbound, and at
  most one outbound edge, which must be default. At most one `createPr` exists.
- Removing budgeted fail edges must leave an acyclic graph. A budgeted edge must
  close a cycle and carry an integer `maxIterations` from 1 through 5.
- `foldKindGraph` associates side effects with their preceding profile node and
  removes their runtime IDs. Execution order is verification, human decision,
  then PR/follow. The visual order of side-effect nodes does not independently
  schedule them; the folded booleans determine execution.
- Run creation resolves enabled profiles and freezes ID/name, CLI, model,
  provider, permission mode, kickoff, system prompt, and autonomous setting.
  Mid-run profile edits do not rewrite that snapshot.
- Pass follows the explicit pass edge, otherwise default, otherwise completes.
  Fail never takes default. An unbudgeted fail edge routes forward. No fail edge
  or `requiresHuman:true` escalates to a person.
- For a budgeted fail edge, a nonempty list consisting entirely of low findings
  is treated as pass. Otherwise, a remaining budget starts another loop; an
  exhausted budget escalates. Empty findings do not become a low-only pass.
- A loop resets nodes on non-loop paths from the repair target to the failing
  reviewer, preserves attempt history, increments the edge counter, and supplies
  the prior verdict to repair/re-review prompts. Human loop-back may exceed the
  automatic budget and records that fact plus a separate operator note.

Sources: `packages/core/src/pipeline/{pipelineGraph,pipelineGraphMigration,loop}.ts`,
`apps/server/src/pipelines/{runStore,graphNavigator}.ts`.

## Lifecycle and explicit transitions

| Event / action                                     | Run state                | Current node / effect                                            |
| -------------------------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| Kickoff / fresh retry                              | `running`                | `pending` → `running`; new stage session and execution-log entry |
| Clean pass, no human gate                          | `running` or `completed` | `passed`; stop/accept session, PR step, follow edge              |
| Clean pass with human gate                         | `awaiting-human`         | `awaiting-gate`; preserve live session for feedback              |
| Verdict failure requiring a person                 | `awaiting-human`         | `awaiting-gate`; verdict/failure evidence retained               |
| Session error, inactivity, PR failure, usage limit | `awaiting-human`         | `failed`; distinct recovery actions                              |
| Terminal path reached                              | `completed`              | `finishedAt` stamped; no PR merge/CI wait                        |
| Provisioning exception                             | `failed`                 | cleanup attempted; initial launch failure is not a human gate    |
| Cancel / abort                                     | `cancelled`              | stop current session, detach driver, attempt orphan cleanup      |

A failed node does not necessarily mean a failed run: most stage failures park
for human action. Forward fail routing preserves the failed attempt and continues
the run. Retrying a stage creates a fresh session; feedback uses the existing live
stage conversation. Attempt logs carry session ID, base SHA, timestamps, verdict,
failure reason, verification evidence, and loop-entry edge where applicable.

Turn completion is explicit. Nonzero exit or native error wins over a verdict
file; a classified usage limit parks, other errors become `session-error`.
A successful work turn reads `.pipeline/verdict.json` with a 64 KiB cap and a
turn-start mtime floor. Missing/invalid verdicts consume at most two automatic
continuation turns before escalation. Invalid diagnostics are server-authored,
not excerpts from the agent file. A `(node, turn)` marker prevents duplicate
continuation consumption; usage is counted only for newer turn numbers.

The parser normalizes pass/fail synonyms, finding headline aliases, and boolean
strings for `requiresHuman`. Unknown severity becomes medium. It requires a
nonempty summary and a usable finding headline. Artifact entries are advisory:
invalid entries are dropped instead of invalidating the decision.

Sources: `orchestrator.ts:510–647,660–852,1439–1477`,
`stageExecutor.ts:evaluateTurnEnd/concludeFromVerdict/readVerdict`,
`packages/core/src/pipeline/pipeline.ts:470–675`.

## Human actions and recovery

| Action         | Exact eligibility and behavior                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| Accept         | Clean `awaiting-gate`, no failure reason; advances and stamps accepted                                           |
| Override       | Escalated `awaiting-gate` with a failure reason; force-passes and records override                               |
| Feedback       | Nonempty text, existing nonfailed node session, alive driver; launches feedback turn and reopens attempt         |
| Loop back      | Current node has budgeted fail edge; explicitly allowed beyond automatic loop budget                             |
| Retry          | `awaiting-human` + `failed`; new session except PR failure, which retries only push/PR                           |
| Wait for reset | Usage-limit failure; schedule reset + 60 seconds, or one hour without a known reset                              |
| Resume now     | Usage-limit failure; clear schedule and restart that stage                                                       |
| Reconcile      | Inactivity failure, or session error with a session ID; valid existing verdict required; rerun conclusion policy |
| Abort          | Cancel an active or parked run                                                                                   |

`verify-failed` uses the override/feedback gate, not ordinary retry. A dead parked
session is marked `sessionEnded`, making live feedback unavailable. `Discuss`
fields and turn kinds remain in types, but CE exposes no discussion controller or
routes. There is no account-swap action, preview orchestration, PR merge polling,
downstream CI integration, or ticket lifecycle.

**Restart support is incomplete in the inspected production wiring.** Durable
runs, scoped turn files, `reconstructTurnOutcome`, and `resumeConcludedNode` exist.
However, a whole-source reference search finds no production caller of the latter
two. `composition.start()` calls `orchestrator.init()`, which registers change and
usage listeners; it does not enumerate/adopt active runs. The usage resume poller
does perform an immediate boot tick. Do not infer full recovery from comments
claiming “boot reconcile.” A new integration must implement and test adoption,
finished-turn replay, pending verification recovery, and detached-session cleanup.

Sources: `orchestrator.ts:895–1127,1236–1344`, `composition.ts:350–386`,
`turnOutcomeReconstruction.ts:138`, `http/routes-pipeline-runs.ts`.

## Verification and watchdog behavior

Verification runs only when a marked node would carry code forward: pass,
forward fail route, or low-only pass. An automatic repair loop or escalation does
not verify first. A pending gate blocks duplicate conclusions. Its exact resolved
repository/step plan, deadline, turn identity, deferred verdict, and fail reason
are persisted before execution; outcome reads must use that frozen plan.

Configuration lives in server storage, keyed by trimmed/case-folded repository
name, outside the target repository. Missing/unseeded configuration service is an
error. An available service with no steps for this repository yields
`not-configured`, sets `verified:true`, and permits continuation. This is an
intentional reference policy, not evidence that checks passed.

At most 20 steps, each timeout and total configured time bounded by two hours.
Steps execute sequentially and all are attempted; a failing blocking step does
not suppress later steps. Nonblocking failures are recorded but do not block.
The container script uses GNU `timeout -k 10s`, per-step exit/log files, and an
EXIT trap for the overall command result. The frozen plan determines file indices.
Per-step tails are 8 KiB. Gate result states include pass/fail/unavailable/timed-out;
`not-applicable` exists in shared types but is unreachable in CE's one-repo path.

Passing verification replays the deferred verdict. A red gate supplies failure
feedback for at most two repair rounds (three failed verification attempts total)
then parks `verify-failed`. No blocking results means unavailable and no repair
budget is spent. Human reopening clears the prior attempt's verification state.

Watchdog sweep: every minute; idle budget 20 minutes, in-flight budget two hours,
restart grace 20 minutes. It combines durable stage/activity timestamps with real
driver activity; an unattached driver with no in-memory activity is skipped.
Pending verification uses its explicit deadline instead of ordinary inactivity.
For normal inactivity it first reads a verdict; if present, it concludes without
stopping, otherwise stops and escalates. That watchdog read lacks the turn-start
freshness filter used by normal turn completion.

Usage-limit recovery uses classified native result errors, not aggregate token
counts. Unknown reset means hourly probes. The reference shares known usage-limit
markers across all runs because it assumes one account; AgentPier must scope this
by actual CLI/account/provider to avoid parking unrelated credentials.

Sources: `verifyGate.ts:startGate/applyOutcomeLocked`, `verifyGateScript.ts`,
`verifyGateResult.ts`, `verifyGatePolicy.ts`, `watchdog.ts`,
`usageLimitController.ts`, `composition.ts:66–78`.

## Workspaces, artifacts, PRs, and cancellation

Provisioning makes one durable Git worktree and branch per run, writes the task,
records its base SHA, then starts the first stage. Origin fetch failure is logged
and local refs may be used; caller may choose a base ref. The reference branch
prefix is `claude/` even for other CLIs. All stages share that run worktree.

Artifacts declare relative paths (20 maximum, path 512 characters, label 120).
Kickoff forwards the latest concluded declaration per other node when a file
exists, plus task/loop/PR context. It forwards paths, not automatic full-file
content. Attempt diffs use the attempt base SHA through the next recorded base,
or the working tree for the latest attempt. HTTP bounds: artifact 2 MiB, diff
512 KiB, verification log 256 KiB. Paths reject traversal and known credential
subtrees, but the reader follows symlinks; lexical checks alone do not contain
artifact reads.

A `createPr` marker pushes the branch and creates one PR against the configured
project base. Creation failure parks `pr-failed`. Later stage conclusions push an
existing PR branch best-effort; push failure does not prevent graph advancement.
Terminal completion does not imply PR merge or successful downstream CI.

Actual cancellation differs from the file header's “keep worktree” claim. It
stops/detaches, marks cancelled, then checks commits ahead of origin. If commits
exist (or the check is uncertain), it pushes and removes the worktree on success;
push failure records `pushFailReason` and pins the worktree. Otherwise it removes
the worktree directly. **Uncommitted-only changes are not protected by this
criterion.** Terminal run deletion also force-removes its worktree; a seven-day
hourly retention sweep skips only push-failure pins. These semantics must not be
copied as a safe “cancel” default into AgentPier.

Sources: `provisioner.ts`, `stageArtifacts.ts`, `http/routes-pipeline-runs.ts`,
`finalizer.ts`, `orchestrator.ts:1139–1229,1603–1620`.

## Port risks and proposed module boundaries

The reference orchestrator and verification controller each exceed 1,600 lines.
Reuse their behavior contracts and test scenarios, not their class size or
container assumptions. Suggested AgentPier boundaries, each below 600 lines:

| Module                                | Responsibility / interface                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline-schema` / `graph-policy`    | Validate definition; compile side effects; pure next-edge/loop/reset decisions                                                      |
| `pipeline-store`                      | Definition/profile versions; immutable run snapshots; attempts/events; transactional revision checks                                |
| `run-transition`                      | Pure state/action eligibility → state change plus explicit effects                                                                  |
| `run-coordinator`                     | Per-run serialization, persisted effect IDs, dispatch and stale-event fencing                                                       |
| `stage-runner` + three CLI adapters   | Start/resume/cancel **owned** stage turns; typed outcome, native session ID, activity, usage; never infer completion from a spinner |
| `verdict-reader`                      | Attempt-scoped bounded data, schema diagnostics, exact freshness/identity checks                                                    |
| `verification-runner`                 | Trusted configured commands; owned process groups; bounded logs/time; results stored outside agent-writable worktree                |
| `gate-service` / `usage-recovery`     | Human actions, feedback, repair budgets, account-scoped scheduled retries                                                           |
| `workspace-service` / `forge-service` | Owned worktree creation, preservation and explicit cleanup; separate authorized push/PR operations                                  |
| `artifact-reader`                     | Declared-attempt lookup; realpath/no-follow containment; bounded text and diffs                                                     |
| `run-recovery` / `watchdog`           | Startup adopt/replay/park; process ownership proofs; durable timers and idempotent outcomes                                         |
| `pipeline-read-model`                 | Paginated runs/attempts/events; action capabilities for existing AgentPier UI                                                       |

Minimal runner contract should identify `{runId,nodeId,attemptId,turnId,sessionId}`
on every outcome and freeze `{accountId,cli,provider,model,permissionMode}` in its
launch snapshot. Persist no credential values. Feed launches through AgentPier's
existing account/provider/GitHub/memory/native-binding preparation, with their
failure cleanup and revocation. Keep Shell ineligible. Preserve the existing
AgentPier Chat/native terminal surfaces and add pipeline context, not a parallel
replacement frontend. Pipeline-owned input must be fenced from ordinary composer
submissions while a stage turn is in flight.

Safety changes needed for native execution:

1. Do not use the reference's agent-writable `.pgid` file sweep on the host. A
   numeric PID is not ownership proof; container namespace assumptions no longer
   hold. Track owned process groups using trusted launch records.
2. Do not treat agent-writable exit files or mtime checks as an authentication
   boundary. Keep verification results in private coordinator storage, and bind
   every verdict/result to a fresh attempt. Apply the same freshness rules to
   watchdog and recovery paths.
3. Preserve dirty/untracked work on cancel and server shutdown. Separate cancel,
   push/PR, deletion, and retention cleanup; check real ownership and dirtiness
   before destructive cleanup.
4. Replace GNU-only timeout/script assumptions with the existing portable Node
   process lifecycle utilities. Wrap an entire configured compound command under
   its timeout; the reference raw interpolation can time-limit only its first
   command and redirect only its last command.
5. Use database revisions plus durable effect/idempotency keys. Reference locks
   are only in-process promises and `RunStore.patch` mutates a cached object before
   persistence; they do not provide cross-process CAS or atomic external effects.
6. Present verdicts, findings, artifacts, and check output as untrusted evidence.
   Artifact declaration cannot authorize reading host credentials, altering
   policy, sending messages, or widening a stage's permissions.

Required tests before declaring full integration: three-CLI stage contract matrix;
generated graph/loop/action invariants; duplicate and late turn delivery; restart
at each launch/result/gate/PR boundary; concurrent runs with separate credentials;
verification timeout and malicious result files; traversal/symlink artifacts;
failed push and dirty cancellation preservation; shutdown with live native stages;
fixture-only browser action eligibility and paginated attempt history.
