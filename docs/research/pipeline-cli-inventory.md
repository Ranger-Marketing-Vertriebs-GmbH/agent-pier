# Pipeline CLI and profile inventory

Reviewed 2026-09-07. This is a read-only inventory of the extracted
`agent-runner-ce-main` reference, followed by an AgentPier integration proposal.
No reference program, model request, installation, credential read, or user
session was executed. Native help/version checks used Codex 0.153.4 and Claude
Code 2.1.263; OpenCode is not installed locally.

Reference paths below are relative to the extracted repository. They describe
the inspected implementation, not guarantees made by current CLI vendors.

## Native launch matrix

| Behavior           | Claude Code reference                                                      | OpenCode reference                                                             | Codex reference                                   |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| Stage command      | `claude -p --output-format stream-json --verbose`                          | `opencode run --format json --auto`                                            | Explicitly rejected                               |
| Prompt transport   | File redirected to stdin, giving EOF                                       | File redirected to stdin, giving EOF                                           | No stage adapter                                  |
| Model              | Optional quoted `--model` from frozen profile                              | Optional quoted `-m` from frozen profile                                       | Profile supports interactive model selection only |
| First conversation | `--session-id` with deterministic UUID derived from AgentRunner session ID | Native new conversation in working directory                                   | No stage adapter                                  |
| Later turn         | `--resume` with the same UUID                                              | `-c`, latest conversation for directory                                        | No stage adapter                                  |
| Native completion  | First `type: result` event                                                 | `error`, or `step_finish` whose reason is `stop`; `tool-calls` is not terminal | No stage parser                                   |
| Permissions        | Always emits validated `--permission-mode`                                 | `--auto`; generated deny configuration remains significant                     | Autonomous profiles rejected                      |
| MCP                | Optional fixed config path and `--strict-mcp-config`                       | Generated inline configuration                                                 | No stage integration                              |
| Plugins            | Unconditionally loads image-baked `/opt/plugins/superpowers`               | No corresponding driver plugin flag                                            | No stage integration                              |

Sources: `apps/server/src/pipelines/turnDriver.ts:19-125`,
`claudeTurnDriver.ts:27-104`, `opencodeTurnDriver.ts:22-145`, and
`driverSession.ts:23-139`. The Codex rejection also exists in profile validation
and the orchestrator before session creation; it is an implementation gap, not
a native Codex limitation.

The shell wrapper records its process-group ID first, changes directory, runs
the CLI with prompt input and append-only JSONL/stderr files, then writes the
shell exit status to a separate file. It relies on the reference container's
process and path isolation. AgentPier must not copy its host-inappropriate
`pkill -9 -x claude/opencode` cleanup.

## Shared driver lifecycle

`HeadlessStageDriver` multiplexes sessions with a CLI-specific `TurnDriver`.
Its responsibilities are substantially larger than command generation:

- Attach freezes the CLI adapter and transcript parser per session. Detach
  releases observation state. Restart `resumeTurn` re-arms an already launched
  turn without executing the prompt again.
- Every turn owns prompt, events, exit, stderr, and process-group files under
  the session ID and turn counter. A shared working directory cannot cause
  two stages' turn files to collide.
- One turn may be active per stage session. Launch failure rolls back the
  counter and activity state so retry cannot accidentally request resume for a
  conversation that never began. The prompt exists before detached launch.
- Completion has three evidence paths: parsed native terminal result, fresh
  exit receipt, or stopped container. Container loss reports exit `-1`;
  result-only completion uses `0`, which is not an observed process exit.
- Result handling may wait for a fresh verdict or child activity to settle.
  Defaults are 2-second polling, 60-second continuous quiescence, and a
  30-minute maximum grace period. These are reference heuristics, not proof of
  native process exit or a successful stage.
- Kickoff, verdict nudge, gate feedback, and discussion refresh are work turns.
  Discussion messages unblock the conversation separately. Verification is a
  shell-command turn, not an additional model request.
- Gate feedback/discussion refresh remove the old verdict only after launch
  succeeds. Verification keeps the existing verdict. Turn start timestamps
  reject old exit receipts and scope verdict freshness.
- Claude terminal usage is per invocation. OpenCode token deltas accumulate
  every parsed chunk across all model steps; a terminal chunk alone would lose
  earlier calls. This billable request usage must not become a context gauge.
- Transcript events pass through the same native parser and redaction/event
  persistence path used for interactive sessions.

Sources: `headlessDriver.ts:54-312,481-590,688-901,941-1237` and
`composition.ts:205-260`. Composition additionally starts reconciliation,
usage-limit resumption, watchdog sweeps, and retained-worktree sweeps. Its
shutdown clears its own timers rather than blindly killing native stages.

## Profiles, context, and authentication

The stored profile is an enabled, named template with description, seed key,
optional phase grouping, timestamps, and this configuration:

```text
cliTool: claude | codex | opencode
models: { available: string[], default: string }
prompts: { role: string, kickoff: string, params: [{ key, label, required }] }
permissions: { mode: CLI-specific value }
run: { autonomous: boolean }
provider?: string | null
```

The reference permission domains are Claude
`default|acceptEdits|plan|auto|dontAsk|bypassPermissions`, Codex
`untrusted|on-request|never`, and OpenCode `ask|auto`. OpenCode autonomous
profiles require `auto` and a nonblank provider. Codex autonomous profiles are
rejected. Required prompt parameters are checked, unknown supplied keys are
errors, and rendering replaces declared `{{key}}` placeholders only.

At run creation, `stageSnapshot` freezes profile identity/name, CLI, default
model, provider, permission mode, kickoff, role as `systemPrompt`, and autonomous
flag. Empty model means native default; empty role means no role. Later profile
edits should not alter a running stage. Seeding is transactional and idempotent
with stable seed IDs. Deletion reference checks belong to callers.

Two limitations are visible in the actual code:

- `systemPrompt` is frozen but is not consumed by pipeline launch or kickoff
  composition. Merely preserving the field does not implement role behavior.
- These profile and driver modules contain no context-window, reasoning-effort,
  compaction, or context-budget control. The model string is a configuration
  request, not evidence of the effective native model or context size.

Sources: `packages/core/src/profiles/profileConfig.ts:18-181`,
`apps/server/src/pipelines/profileStore.ts:43-149`,
`apps/server/src/pipelines/orchestrator.ts:737-762`, and the driver modules.

Reference provider resolution is explicit profile pin, then project provider,
then global default. A provider incompatible with the CLI falls back to stored
CLI login resolution. Stage sessions create a private HOME under the server
data directory, materialize provider or CLI-login secrets there, resolve MCP,
and mount the project clone at its identical absolute path in a Docker sandbox.
They require configured commit identity and validate project environment keys.
MCP secrets use a separate service. Materialized secrets are held for transcript
redaction, not stored in public session metadata. OpenCode gets inline config
plus project-config disabling. Profile rows themselves contain no credentials.

Sources: `apps/server/src/models/providers.ts:170-187` and
`apps/server/src/sessions/stageSessions.ts:170-335`. AgentPier already has more
explicit per-account provider ownership; this fallback chain should not be
ported into managed gateway accounts.

## Project, worktree, and branch provisioning

The provisioner persists a run before expensive work and serializes preparation
with run cancellation/gates. It fetches origin with existing credential wiring,
reports fetch failure as a warning, resolves the base, creates one shared run
worktree, records its initial SHA once, writes `.pipeline/task.md`, and starts
the entry node. The project is selected by ID and registered path, not by a
profile. Profiles are reusable stage templates; project provider selection is
a separate fallback configuration.

The run workspace is `<project>/.agentrunner-worktrees/<runId>`, on a generated
`claude/<first-eight-run-id>` branch even when OpenCode drives it. Creation uses
`git worktree add --no-track -b <branch> <path> <base>`: the run branch must not
inherit the base branch's upstream. Requested branch names prefer an existing
`refs/remotes/origin/<name>`; otherwise Git resolves the original request and
unknown refs fail. With no resolved request, the Git port uses `HEAD`. Fetch
does not reset or check out the user's branch.

Provisioning failure marks the run failed, reaps owned stage sessions, records
failure, and attempts fenced cleanup without masking the original error.
Worktree removal is restricted beneath the owned root. Completed worktrees
have a seven-day retention policy; inability to establish that commits are
already on origin prevents automated removal. Ordinary session worktrees have
a separate explicit-prune policy. These policies should remain distinguishable.

Sources: `provisioner.ts:95-285`, `apps/server/src/git/fetch.ts:40-110`,
`apps/server/src/projects/worktrees.ts:1-96`, and `composition.ts:43-114`.

## Current native capabilities beyond the reference

Codex supports `exec --json`, explicit `exec resume <session-id>`, and prompt
stdin. JSONL exposes a native thread ID and turn results. Preserve persistence
and capture the thread ID rather than using latest-session selection. Local
help additionally confirms explicit output-schema support on initial and
resumed exec, model/config overrides, and sandbox selection on exec.
[Official Codex documentation](https://developers.openai.com/codex/noninteractive).

Claude supports print output and explicit conversation resumption. Local help
confirms session UUID selection, append-system-prompt, stream JSON, and explicit
permissions. Its installed mode vocabulary includes `manual`, while the
reference uses `default`; capability/version validation must avoid copying a
stale enum. Persist native history; do not enable no-session-persistence.
[Official Claude documentation](https://code.claude.com/docs/en/headless).

OpenCode documents `run --format json`, explicit `--session`, provider/model
IDs, model variants, and `--auto` with explicit denies remaining effective.
Explicit session resumption is preferable to the reference's directory-wide
`-c`. An installed-version help check remains necessary before launching this
adapter because OpenCode was unavailable for local validation.
[Official OpenCode CLI documentation](https://opencode.ai/docs/cli/).

## Proposed AgentPier integration contract

Use normal AgentPier session creation for every native turn. A trusted internal
launch transform can replace interactive arguments after account resolution and
before native process launch while preserving provider, GitHub, AgentBus,
project-memory, bindings, cleanup, and history initialization. Do not expose
arbitrary launch transforms through public JSON.

```text
Workspace.prepare({ runId, cwd, baseBranch })
  -> { cwd, projectRoot, branch, baseSha, ownership }
Workspace.inspect(ownership) -> repository/worktree status
Workspace.remove(ownership) -> explicit, fenced cleanup

Driver.start({ runId, nodeId, attemptId, turnId, profileSnapshot,
               cwd, prompt, kind, resumeNativeId? })
  -> { sessionId, nativeId?, startedAt }
Driver.inspect({ sessionId, runId, nodeId, attemptId, turnId })
  -> { status, exitCode, nativeId?, nativeResult?, usage? }
Driver.cancel(exactOwnedIdentity)
```

The engine persists launch intent before starting. Public session metadata
contains only allowlisted run/node/attempt/turn identifiers. Recovery joins
those identifiers to existing owned sessions before deciding whether launch is
needed. Callbacks may accelerate transitions, but persisted identity and native
inspection remain authoritative. Web-only restart reattaches observation;
it must not replay a prompt or revoke a still-running memory capability.

Each turn gets a normal terminal-backed AgentPier session and bounded native
JSONL observation; explicit native conversation ID connects subsequent turns.
Bind Chat to that same native history. Pipeline controls enqueue feedback only
through the engine's turn lock; direct terminal/chat injection must not race a
headless stdin consumer. Pipeline and ordinary sessions share the same Chat and
Terminal components, with capability-appropriate controls.

Freeze account ID, CLI, provider identity/model configuration, role, kickoff,
and explicit native permissions per run. Resolve the current secret at each
launch; key rotation does not change a model/profile snapshot. Reject deleted
accounts or changed tool/provider configuration rather than substituting
another identity. Never snapshot credentials. Resolve model/context metadata
through the existing provider catalog; retain its distinction between
configured limits and observed native context. Actually apply role instructions
using a validated native option or an explicit prompt section.

Completion requires actual owned process termination plus validated, fresh,
attempt-scoped verdict evidence. Native errors can fail a turn even if the
process returns zero. Missing/invalid verdict and unknown exit status are
explicit unresolved/error states, never inferred success from silence. Preserve
the existing tmux status-reaping workaround. Cancellation stops only the exact
owned session; it preserves worktree and branch. Push, pull-request creation,
and destructive cleanup are separate explicit operations using existing GitHub
credentials, with no host-wide process-name cleanup or automatic default-branch
mutation.
