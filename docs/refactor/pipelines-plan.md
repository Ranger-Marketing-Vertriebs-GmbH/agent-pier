# Native pipelines implementation contract

The pre-pipeline gate passed all six remote jobs at `6a749cc` (run `34065818044`). The user-owned reference was first inspected after that gate. Inventories in `docs/research/pipeline-*-inventory.md` distinguish working reference behavior from unimplemented or unsafe paths.

## Decisions

- Retain AgentPier's accounts, provider configuration, shared repository memory, AgentBus, native session storage, Chat and Terminal. Pipeline profiles are reusable task/role templates, separate from credential accounts. No Docker requirement or global installation.
- Add one navigation destination, Pipelines, with URL-addressable runs, definitions, profiles and verification settings. Use the existing dark/orange components, paginated lists and mobile layout. The builder uses ordered stage cards, gate/verify/PR options and finite fail loops; valid advanced graphs remain editable as JSON without silently rewriting them.
- Use a durable owned Git worktree and branch per run. Aborting preserves work. Cleanup is a separate explicit operation on finished runs and never removes an unowned path. External push/PR operations occur only when explicitly selected by the user through a PR node/action.
- Run one native headless CLI turn at a time per run. A real process outcome and a fresh bounded structured verdict determine completion. Terminal inactivity is not success. Every turn remains a normal AgentPier session with links to Chat and Terminal. Codex support is implemented rather than inheriting the reference's missing adapter.
- Freeze graph/profile/model/permission configuration at kickoff. Reuse account credentials at launch without persisting secrets in run snapshots. An incompatible changed account must produce a clear failure, not silently change a run's provider. Provider model overrides use the existing verified context/catalog rules.
- Persist state before starting side effects. On web restart, reconcile the exact persisted native session; never launch a duplicate turn. Ambiguous interrupted side effects become an actionable gate. Preserve execution history, verdicts, verification plans/results, diffs, artifacts and usage across retries/loops.
- Side effects execute only on the selected graph branch. The reference folds side-effect flags globally onto their source stage; reproducing that behavior could publish a PR from an unselected default branch. AgentPier preserves branch-specific effects instead.
- A pass follows its pass edge, then default; a fail follows only an explicit fail edge. Every graph cycle requires a bounded fail edge (1–5). Human-required findings and exhausted loops always gate. Human actions include accept, feedback, loop-back, override, abort, late-verdict reconcile, retry, wait-for-reset and resume-now.
- Verification commands are user-controlled configuration in AgentPier data, frozen per attempt. Execute every step with its own timeout and bounded logs; only blocking failures affect the verdict. No inferred verification success when execution is missing. Preserve remediation feedback and bounded retries.
- Keep all source/test/style files at most 600 lines. Use isolated synthetic CLIs, repositories, profiles and sockets for tests; no paid calls or existing-session input.

## Shared contracts

### Definitions

`PipelineDefinitions({dataDir, accounts})` exposes synchronous `listProfiles({enabledOnly?})`, `getProfile(id)`, `saveProfile(body,id?)`, `removeProfile(id)`, `listPipelines()`, `getPipeline(id)`, `savePipeline(body,id?)`, `removePipeline(id)`, `getVerification(projectId)`, `saveVerification(projectId,{steps})` and `snapshot(pipelineId)`.

Profile shape: `{id,name,description,enabled,phaseKey,seedKey,revision,createdAt,updatedAt,config:{accountId,cliTool,models:{available,default},prompts:{role,kickoff,params:[{key,label,required}]},permissions:{mode},run:{autonomous}}}`. Empty model means the account/native default. CLI-specific permission domains follow the native adapters. Profile account selection supplies provider configuration and credentials; there is no second provider-key store.

Pipeline shape: `{id,name,description,graph:{entry,nodes:[{id,kind,profileId?}],edges:[{from,to,condition,maxIterations?}]},revision,createdAt,updatedAt}`. Kinds: `profile`, `gate`, `verify`, `createPr`. Conditions: `default`, `pass`, `fail`. Definition writes validate enabled autonomous profiles without required parameters. Snapshot returns `{pipeline,profiles}` where `profiles` maps profile IDs to complete frozen profiles including public account configuration.

### HTTP/UI

- `/api/pipeline-profiles` GET all (optional `enabled=true`), POST; `/:id` GET/PATCH/DELETE; `/:id/stats` GET; `/:id/launch` POST `{cwd,params?,model?}` for a standalone profile session.
- `/api/pipelines` GET/POST; `/:id` GET/PATCH/DELETE. Delete rejects active runs and preserves finished history.
- `/api/pipeline-verification/:projectId` GET/PUT `{steps:[{name,command,timeoutMs,blocking}]}`; projects come from `/api/memory/projects` (POST `{cwd}` registers a project).
- `/api/pipeline-runs` GET with `page`, `status`, `projectId`; POST `{pipelineId,cwd,task,baseBranch?}`. List response `{runs,total,page,pageSize:20}`; single responses `{run}`.
- `/api/pipeline-runs/:id` GET/DELETE; `/:id/gate` POST `{action,feedback?,resumeAt?}`; `/:id/cancel`, `/:id/retry-stage`, `/:id/pull-request` POST.
- `/:id/verdict-status` GET; `/:id/nodes/:nodeId/artifacts` GET; `/:id/nodes/:nodeId/artifact?path=` GET; `/:id/nodes/:nodeId/diff` GET; `/:id/nodes/:nodeId/verify-logs/:stepIdx` GET.
- Lists of profiles/definitions respond `{profiles}` / `{pipelines}`; single definitions `{profile}` / `{pipeline}`; verification `{projectId,steps}`. Standard AgentPier error response `{error: string}`. Unknown IDs 404, wrong phase/in-use/conflict 409, invalid input 400.

## Ownership and sequence

1. Root: profile/definition/graph/prompt validation and stores, seeds, HTTP adapters, application composition, documentation and integration tests.
2. Native worker: trusted session-launch extension, headless adapters, workspace/Git/PR ports and CLI matrix/native fixtures. Coordinate exact port signatures with engine worker before implementation.
3. Engine worker: durable run state machine, verification runner, artifacts, bounded retries/loops, recovery and lifecycle/property tests. Keep ports injectable for deterministic tests.
4. UI worker: pipeline destination/routes, profiles, builder, run/gate/artifact/verification views, existing session links and desktop/mobile browser tests. Preserve existing navigation/session components.
5. Root integrates, reviews every reference capability, runs the complete local and remote strategy/browser matrix, restarts only the owned web process, then commits/pushes and completes the whole goal.

The user explicitly requested autonomous completion; routine design choices are recorded here without another approval checkpoint. Pipeline work does not close the goal until the whole feature is implemented and verified.
