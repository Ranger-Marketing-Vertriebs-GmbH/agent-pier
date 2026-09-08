# Reference pipeline and profile UI inventory

Inspected on 2026-09-07. This is a read-only source inventory, not a runtime validation. No reference code was executed and no dependencies were installed. Paths below are relative to the extracted reference root:

`/private/var/folders/1w/z8gvytwx35g_7tz7kqf1z4z80000gn/T/agentpier-pipeline-reference-8k00kxik/agent-runner-ce-main`

## Capability boundary

The reference presents pipelines as **ordered stages**, with one active stage, explicit human decisions, verification, and bounded backward failure loops. Its editor is not a general graph canvas. Task profiles are reusable stage/session templates, not credential accounts. Definitions, frozen run snapshots, individual stage sessions, and repository verification configuration are separate resources.

The source does **not** provide autonomous Codex stages: `validateProfileConfig` explicitly rejects autonomous Codex with “AR-537 not built”. AgentPier's intended three-CLI autonomous support is an additional implementation requirement, not functionality that can be copied from this reference.

## Pipeline overview and launch

Source: `apps/web/src/pages/Pipelines.tsx`.

| User capability        | Actual behavior and supporting functions                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run inbox              | `PipelinesPage` loads definitions and runs, polls every five seconds, groups runs into HUMAN GATE, RUNNING, and RECENT. Recent includes completed, failed, cancelled. |
| Project filter         | Loads projects once; filters the fetched run list locally. Definitions remain visible independently of the selected project.                                          |
| Run progress           | `Stepper`, `orderedNodes`, `stageVerdictLabel`: stage names and statuses, following default edges from entry then appending otherwise unvisited nodes.                |
| Gate summary           | `GateRow`: task, age, stage/verdict or failure reason, findings count. Approve posts `accept`; Review opens run detail.                                               |
| Running/recent summary | `RunningRow`, `RecentRow`: task, stage, loop attempt, known nonzero cost; recent completion/PR number or failed stage.                                                |
| Definitions            | `DefinitionRow`: name, profile-stage count, gate count, link to editor. New pipeline opens builder.                                                                   |
| Start run              | `NewRunSheet`: required pipeline, project and task; POST `{pipelineId, projectId, task}` then open created run. The basic sheet has no base-branch input.             |
| Related management     | Links to profiles and an embedded verification configuration sheet.                                                                                                   |
| Recovery UI            | Loading, request errors, empty states, mutation busy state and temporary notices.                                                                                     |

The list UI requests the full run list and has no pagination controls or free-text search. The API additionally supports project/status filtering and optional limit/offset paging (`routes-pipeline-runs.ts:136`).

## Pipeline definition builder

Source: `apps/web/src/pages/PipelineBuilder.tsx`, especially `BuilderStage`, `readStages`, `buildGraph`, `setCreatePr`, `stageListError`, `isStageable`, and `PipelineBuilderPage`.

- Create or edit a definition; edit name, see counts, save explicitly. The `description` field is loaded and sent back but has no visible editor in this screen.
- Add a stage using an enabled profile; display descriptions in the picker; replace its profile; remove a stage. Removing a stage clears other stages' loop references to it.
- Reorder by drag/drop or ArrowUp/ArrowDown on the reorder button. The stage menu changes profile, adds/removes a fail loop, and removes the stage; it does not provide separate move-up/down menu actions.
- Stable local stage keys keep loop destinations attached to stage identity across reordering. Saving refuses loops whose target is no longer an earlier stage.
- Per-stage switches: human gate, verification gate, and opens the run PR. Enabling PR creation on one stage clears it everywhere else; at most one PR node is supported.
- Optional failure loop to an earlier stage, with an automatic iteration budget of 1–5 (`PIPELINE_LOOP_MAX_ITERATIONS`); a new stage defaults to budget 2.
- Only autonomous profiles without required parameters are selectable as stages. Disabled profiles remain available for resolving existing stage names, not adding new stages.
- At least one stage, every stage has a profile, backward loop targets valid, and shared graph validation must pass before saving.
- `buildGraph` converts UI flags into canonical explicit side-effect nodes in order **verify → human gate → create PR**, preserving the default continuation and failure route. `readStages` folds this representation back into cards.
- Non-chain graphs are rejected for editing rather than silently flattened: examples include pass-edge fan-out, forward fail routes, and orphan nodes.

There is no visible definition-delete button, duplicate/import/export control, parallel-stage editor, schedule editor, or stage-specific cost/timeout editor in this builder. Definition deletion exists through the API and deletes associated runs through the orchestrator.

## Run detail, evidence and decisions

Source: `apps/web/src/pages/PipelineRun.tsx`: `PipelineRunPage`, `gateButtons`, `GateFeedback`, `StageRow`, `FindingList`, `VerifyFailures`, `openStageDiff`, `recheckVerdict`.

| Surface                | Actual supported behavior                                                                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header/footer          | Task, run menu, elapsed time, known nonzero total cost, branch; PR URL if created. Poll run every five seconds.                                                                                                                                                   |
| Timeline               | Every ordered stage, current status, elapsed duration, actual recorded human gate decision, verification state, loop/re-review attempt, failure reason and loop origin.                                                                                           |
| Stage session          | A gated node with `sessionId` links to its session. The reference timeline only exposes this link for a gated stage.                                                                                                                                              |
| Verdict                | Pass/fail, summary, findings with severity and blocker/informational counts. A high-severity finding is counted as blocking. Failure reasons distinguish missing/invalid verdict, session error, inactivity timeout, PR error, usage limit, verification failure. |
| Diff                   | Fetch started nodes' diffs keyed by stage status/finish signature; show added/removed counts, colored diff text, empty diff and truncation notice. Missing base/worktree is reported as unavailable, not a fabricated empty diff.                                 |
| Artifacts              | At a human gate, list the current node's declared/fallback artifacts; unavailable files disabled; view available text in a sheet.                                                                                                                                 |
| Verification evidence  | Failed or timed-out command steps with blocking/advisory label, exit outcome and per-step log viewer.                                                                                                                                                             |
| Approve                | `accept`; primary action becomes `resume-now` at a usage-limit gate.                                                                                                                                                                                              |
| Override/abort         | Explicit confirmation before force-passing or aborting the run.                                                                                                                                                                                                   |
| Retry                  | Dedicated `retry-stage` endpoint, offered for an actually failed node. Not offered for a clean pass gate or verdict escalation parked as `awaiting-gate`.                                                                                                         |
| Same-stage feedback    | Nonempty text resumes the parked stage's own live session. Shown only with a session, nonfailed node, and session not ended.                                                                                                                                      |
| Earlier-stage feedback | Same text can target the configured failure-loop destination; the judging stage runs again afterward. Target derives from the actual edge, not visual order.                                                                                                      |
| Usage-limit recovery   | Actual five-hour/seven-day usage percentage and reset time when reported; resume now, wait for reset, or abort.                                                                                                                                                   |
| Reconcile              | Re-check verdict first; distinguish absent from unreadable verdict, then post `reconcile` if one exists.                                                                                                                                                          |
| Pull request           | Create or refresh run PR via run menu.                                                                                                                                                                                                                            |
| Cancel/delete          | Cancel stops the active stage and retains worktree. Delete removes run, containers and worktree, with confirmation; terminal runs show delete in footer.                                                                                                          |

Action availability is reason-sensitive: verification failure offers override/abort; PR failure offers retry/abort; usage-limit failure offers wait/abort plus primary resume; other actually failed nodes offer retry/override/abort. Server phase checks remain authoritative.

The reference `GateAction` contract allows a human `loop-back` even after the automatic budget is exhausted (`packages/core/src/pipeline/pipeline.ts:720`). This must be an explicit AgentPier policy decision; do not confuse the automatic loop cap with a claim that a human can never request another round.

No run-detail streaming transcript, embedded terminal, arbitrary DAG editor, account-swap gate action, or visible execution-log history panel is implemented here. Existing session screens provide the conversation/terminal; core DTO declarations alone are not evidence that a route or screen exists.

## Verification configuration

Source: `Pipelines.tsx:404` (`VerifyGateSheet`), `apps/server/src/http/routes-verify-config.ts`, `apps/server/src/pipelines/verifyConfigStore.ts`.

- List per-repository command sequences, keyed by repository full name; display step and blocking counts.
- Add repository configuration with an initial named command; add further steps; edit names/commands and blocking flags; save the complete repository configuration.
- Confirm removal of an entire repository's verification configuration.
- Stored steps include `timeoutMs`; new UI steps default to 600,000 ms. The UI does not expose timeout editing, individual step deletion, or step reordering. The API accepts the whole ordered steps array and validates timeout/step bounds.
- A stage's verification switch selects where verification applies. A repository with no configured verification has no commands to run; the reference documents this as a no-op.

## Profiles and starting ordinary sessions

Sources: `apps/web/src/pages/Profiles.tsx`; `packages/core/src/profiles/{profileConfig,seedProfiles,sessionPrompt}.ts`; `apps/server/src/pipelines/profileStore.ts`; `apps/web/src/pages/NewSession.tsx` (`chooseProfile`, submission).

- Manage enabled and disabled profiles. Rows show name, CLI, autonomous/interactive mode and permission mode. Grouping phases: refinement, planning, implementation, review, maintenance, custom. Empty groups are omitted.
- Seed-key taxonomy takes precedence over a user-assigned phase for seeded profiles. User-created profiles use the assigned phase or Custom.
- Create/edit: name, optional description, enabled state, assignable phase, CLI, autonomous state, tool-specific permission mode, optional provider pin, allowed models plus default, role prompt, kickoff prompt, text parameters with key/label/required flag.
- Model entry is comma-separated and trimmed; duplicate model IDs are not removed by this editor. Empty means CLI default (`['']`). Default must be an allowed model. This profile editor uses text entry, not a catalog search; the separate New Session picker supports provider-model search/context display.
- Changing CLI keeps only a permission mode valid for the new CLI; otherwise resets to that CLI's first, most restrictive mode. Claude modes are default/acceptEdits/plan/auto/dontAsk/bypassPermissions; Codex untrusted/on-request/never; OpenCode ask/auto.
- Autonomous requires a nonempty kickoff. Codex autonomy is rejected. OpenCode requires a provider, and autonomous OpenCode requires auto. Pipeline stage eligibility additionally excludes required parameters.
- Parameters use unique `[A-Za-z0-9_]+` keys. Required values and unknown submitted keys are checked. Only declared `{{key}}` slots are substituted; unknown template slots remain literal.
- Delete confirms; deletion is rejected with 409 while a definition references the profile. Existing runs retain their frozen profile snapshots. There is no visible clone/import/export/reset-to-seed control.
- Eight persisted starter profiles: Planner, Implementer, Code Reviewer, Security Reviewer, Conflict Resolver, Bug Hunter, App Tester, App Tester (interactive). Bug Hunter and interactive App Tester are interactive; the other six are autonomous. Seeds are inserted once behind a marker and are editable; a separate synthetic Default profile is defined but not prepended by the profile management API.
- Ordinary-session launch can select an enabled profile. `chooseProfile` seeds CLI, approval/provider/model choices and clears parameter values; visible launch choices remain overrideable. Clearing the profile does not revert already visible choices. Required profile params are rendered only for an ordinary session, not pipeline start.
- `composeSessionPrompt` combines role, rendered kickoff and owner's prompt as one first message, dropping empty blocks. An entirely empty composition starts the CLI waiting for input.
- Pipeline `stageSnapshot` freezes profile ID/name, CLI, default model, provider, permission mode, kickoff, role and autonomy. Later profile edits do not change existing run snapshots.

The seven-day profile usage count exists at `GET /profiles/:id/stats`, but `ProfilesPage` does not display it.

## Reference API surface

All routes below are under `/api`; response envelopes and error objects are reference-specific, not an instruction to replace AgentPier's existing error format.

| Resource     | Routes relevant to parity                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profiles     | GET `/profiles` (enabled), `/profiles/all`, `/profiles/:id`, `/profiles/:id/stats`; POST `/profiles`; PATCH/DELETE `/profiles/:id`.                                               |
| Definitions  | GET/POST `/pipelines`; GET/PATCH/DELETE `/pipelines/:id`. Writes carry name, nullable description and graph.                                                                      |
| Runs         | GET `/pipeline-runs` with optional projectId/status/limit/offset; POST with pipelineId/projectId/task and optional baseBranch accepted by route; GET/DELETE `/pipeline-runs/:id`. |
| Decisions    | POST run suffixes `/gate`, `/cancel`, `/retry-stage`, `/pull-request`; GET `/verdict-status`. Gate body contains action and optional feedback.                                    |
| Evidence     | GET run node suffixes `/artifacts`, `/artifact?path=...`, `/diff`, `/verify-logs/:repoIdx/:stepIdx`.                                                                              |
| Verification | GET `/verify-config`, `/verify-config/:repo`; PUT `/verify-config`; DELETE `/verify-config/:repo`.                                                                                |

Supporting route functions: `pipelineDefinitionRoutes`, `pipelineRunRoutes`, `verifyConfigRoutes` in `apps/server/src/http/routes-{pipelines,pipeline-runs,verify-config}.ts`. The run reader returns persisted snapshots; the UI does not reconstruct execution facts from text.

## Proposed AgentPier UX and implementation boundaries

This is a proposed adaptation pending the shared schema/API, not implemented behavior.

1. Add a Pipelines management destination with Runs, Definitions, Profiles, Verification tabs and stable deep links. Preserve the current collapsible sidebar, dark neutral surfaces, orange accents, compact directory rows and mobile navigation.
2. Keep **task profiles separate from accounts**. A profile selects an existing `accountId` so credentials and provider configuration remain owned by Accounts. Show CLI and optional exact model pin, launch mode, autonomy, role/kickoff and parameters. Scope model choices to that account/provider and preserve unknown limits. A profile must not become another API-key store.
3. Use ordered stage cards with explicit move controls suitable for touch/keyboard, alongside optional drag support. Keep profile selection, gate/verify/PR flags, named earlier-stage target and numeric loop cap on focused controls. Keep non-chain graphs protected from lossy editing.
4. Run pages show a persistent stage timeline and prominent decision panel only when needed. Open each actual stage session in AgentPier's existing Chat/Terminal workspace, retaining draft/scroll, model/configuration distinction, native context/subagent observability and working status. Keep stage output/evidence separate from verdict facts.
5. Reuse `Modal`, `ErrorMessage`, `AsyncForm`, `AnchoredSelect`, `Pagination`, `Icon`, `ProviderMark`, `lib/api`, `useAsyncAction`, `DirectoryPicker`, provider model details/catalog hooks, existing account selector conventions, and `sessionPresentation.sessionActivity`. Add focused feature modules under `web/features/pipelines` and `web/features/task-profiles`; avoid importing one large page into another to share helpers, as the reference does.
6. Use AgentPier route parsing/history conventions; query-backed project/status/page filters, stale-response protection keyed by scope, mutation locks and explicit error recovery. Preserve German product copy in semantic locale data and English code. All source/styles remain below the existing 600-line gate.
7. AgentPier's three-CLI autonomous drivers require explicit capability metadata and native outcome contracts; Codex support is new work. UI should display supported modes from the contract, not repeat reference assumptions about Claude/OpenCode or infer success from a process exit alone.

## Acceptance scenarios derived from the reference

- Profile create/edit/disable/delete-reference conflict; per-CLI mode changes; parameters and ordinary-session overrides; frozen snapshots after profile mutation.
- Definition round-trip, singleton PR, verify→gate→PR ordering, stage reorder/remove with loop targets, budget bounds and non-chain edit rejection.
- Run start and deep-link reload; actual stage progress, pending gate, verdict/findings/evidence, unknown cost/usage and missing diff states.
- State-specific accept/feedback/loop-back/retry/override/abort/reconcile/usage-limit actions; recoverable 409 with the draft retained; no duplicate mutation.
- Verification command configuration, failed/advisory/timeout outcomes and logs; cancellation versus deletion resource semantics.
- Mobile stage controls, long task/finding/diff bounds, modal Escape/opener focus, navigation cancellation, stale polling, session Chat/Terminal continuity and restart recovery.

Reference tests supporting this inventory: `apps/web/src/pages/Pipelines.test.tsx`, `Profiles.test.tsx`, `NewSession.test.tsx`; `apps/server/test/routes-pipelines.test.ts`; `packages/core/test/seed-profiles.test.ts`. Their presence is evidence of intended contracts, not a claim that they were executed during this inventory.
