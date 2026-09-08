# Full refactor progress

Plan: [plan.md](plan.md). Baseline: `760e788942bd71b7806b434a365b9bfadad2c762`.

## Scope and execution

The active goal includes the complete refactor, repository memory, API providers, chat observability and presentation, followed by native pipelines and profiles. Intermediate passing checks do not complete the goal. The user authorized autonomous implementation and local test servers, with no global CLI/service installations or paid model calls.

The existing checkout on `feat/local-cli-workspace` is retained to preserve the authorized local runtime. Real user terminals remain protected; process tests own temporary homes, data directories and tmux sockets. Independent implementation and review work follows the plan's subagent workflow with explicit file ownership.

## Refactor foundation

- Baseline: 200 backend and 87 browser tests.
- Server migration retained all 200 backend tests. Feature domains, application composition, launch lifecycle, feature routers, terminal WebSocket transport and shutdown now have separate responsibilities. Shared launch serialization and configuration boundaries replace repeated implementations.
- Stable executable adapters remain for configurations referenced by running native CLIs.
- React migration retained all 87 browser tests. The application shell, feature components, hooks, shared controls and styles now have explicit boundaries. English semantic keys reference German locale dictionaries; numbered placeholder keys were removed.
- Tests now use unit, integration, blackbox, property, matrix and browser directories with shared fixture ownership and reproducible fast-check seeds. Two parameterized repository navigation cases omitted during migration were detected and restored before acceptance.
- A deterministic installer regression exposed terminal job status before staging cleanup finished. Final status now follows cleanup; the regression passes.
- ESLint, Prettier and a 600-line source/style/test limit are automated. The latest structure check covers 295 files. Node minimum is 22.13; local runtime is 22.22. Repository-local browser binaries are excluded from source checks.

## Repository memory

- SQLite WAL storage resolves Git worktrees to their common repository scope, preserves immutable revisions and uses compare-and-swap updates.
- Session capabilities bind native MCP calls to the project and trusted writer identity. All three CLI adapters are covered; shell/login are excluded. Search uses bounded excerpts and full-entry retrieval is explicit.
- Independent review led to a 256 KiB MCP response cap and explicit stop/natural-exit revocation. Natural exit is reconciled on existing native state reads without additional terminal polling. Web-only restarts preserve access for running sessions; project knowledge persists after session deletion.
- Memory-owned backend tests: 32 passing. Lifecycle regression run: 55 passing. Public API and browser tests cover conflicts, revision history, archive/restore, durable state, deep links and mobile creation.
- Browser review identified stale pagination after removing the last item on a page and mismatched history contents during a page request. Both fixes and their regression tests pass.

## Providers and chat

- Provider configuration separates credentials, native identifiers, endpoint capability and advertised/routed/output context metadata. Native OpenCode provider IDs are used. Codex with Z.ai requires explicit Responses entitlement confirmation.
- Public metadata omits secrets. Configured session model/context remains separate from native confirmation, and restart-only model controls reject terminal mutations while retaining cancellation.
- Provider backend/account tests: 40 passing; public HTTP tests: 3 passing; model guard/session metadata tests: 5 passing.
- Native Codex configuration parsing was checked with an isolated profile. This does not prove paid gateway inference or successful loading of every custom model catalog. Compatibility limits are recorded in [providers.md](../providers.md).
- Provider and chat UI additions passed 18 browser cases. User messages are compact right-aligned bubbles; session rows include directories; current native context and subagent state have dedicated presentation with unknown/stale handling.
- Provider UI review identified unchanged-provider edits being treated as credential changes, plus catalog availability unnecessarily blocking unrelated edits. Both fixes and their regression tests pass.
- Native chat observability parsers and persisted snapshots passed final edge-case/property verification. Review corrected Codex native total/baseline accounting, source recency, Claude task/agent identity correlation and background dispatch uncertainty.

## Current whole-tree verification

- `npm run check`: lint, formatting, 600-line gate, all 390 backend tests and production build pass.
- Alternate property seed `173205`, 300 runs: 19/19 passing.
- ESLint passes after excluding repository-local downloaded browser code.
- Full isolated production browser suites pass: Chromium 114/114 and WebKit 114/114. WebKit exposed task-drawer focus ordering, fixture hydration/encoding and absent navigation activation metadata; regression fixes retain API/frame/mutation origin restrictions.
- The first remote matrix passed both Linux browser jobs (114 cases each). Backend jobs exposed a fresh-checkout prerequisite (HTML tests need a production build) and an expected Git-cancellation TLS reset escaping the fixture. The check command now builds before testing; socket observation awaits actual closure and asserts expected reset errors. A fresh archive passed the build/HTTP sequence, and two deterministic socket regressions cover the reset ordering. The second matrix passed both browser jobs and three backend combinations. Ubuntu/Node 22 exposed tmux 3.4 closing a PTY before waitpid supplied its exit status: empty status was incorrectly parsed as successful exit 0. Session state now waits for a reported status or signal without arbitrary delays; four deterministic readiness tests and the unchanged real exit-7 integration pass. Local `npm run check` now passes all 390 backend tests. The next matrix passed three backend combinations and both browser jobs; Ubuntu/Node 24 timed out observing a synthetic memory child exit. The fixture now proves child readiness before restarting the web application and records child/exit/pane diagnostics without extending its deadline. In the following matrix all memory tests passed, while Ubuntu/Node 24 exposed a separate shell exit observation timeout. The diagnostic run confirmed the shell consumed its exit command and disappeared, while the tmux pane process remained a zombie with `pane_dead=1` and no reported status under both Ubuntu/Node 22 and 24. This matches the upstream tmux utempter/SIGCHLD lost-reap issue ([4559](https://github.com/tmux/tmux/issues/4559), [upstream correction](https://github.com/tmux/tmux/commit/fa5f3cef3d651b0eb9abfa77fc37ccade81679b5)). For exact closed-pane/missing-status state, AgentPier now runs a fixed no-output job on the same private tmux server and rereads native status. The resulting child signal wakes tmux’s reaper; the actual exit code remains authoritative. A deterministic regression verifies real nonzero status recovery and no trigger for running/already-reaped panes; focused lifecycle tests pass. The corrected [remote matrix](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/actions/runs/34065818044) is green at `6a749cc`: all four macOS/Linux × Node 22/24 backend jobs and both Chromium/WebKit jobs pass. CI backend runs 389 passing tests with one optional installed-Codex check skipped; local runs 390/390. Ubuntu/Node 24 also passes ten repetitions of shell and memory exit cases. This closes the pre-pipeline verification gate.
- The owned local test web process was restarted successfully. Built HTML and provider routes respond successfully; the three protected launcher/native process IDs remain alive. No goal completion has been claimed.

## Final integration

The pre-pipeline phase is committed, pushed and verified. The final native pipeline phase is implemented, independently reviewed and verified locally and remotely. The final runtime audit preserves existing native sessions.

## Native pipeline implementation

The final phase began only after the pre-pipeline matrix passed. Three read-only inventories cover the user-owned reference's engine, CLI drivers and UI. Actual gaps (disabled Codex driver, missing boot recovery wiring, unused role prompt and cancellation data loss) are recorded separately from working reference features. The implementation contract is [pipelines-plan.md](pipelines-plan.md).

Definition/profile storage, finite graph validation, shared prompt parameters, seeded editable profiles and HTTP composition are implemented. Five definition/property tests and the existing security suite pass; new public HTTP tests cover CRUD, conflicts, project verification, invalid graphs and origin checks. A full isolated HTTP run drives a real synthetic native CLI through tmux, its owned Git worktree, private verification, artifacts/diff, a human gate and a web restart before acceptance; the source checkout remains unchanged.

Native drivers, durable run/turn recovery, verification supervision and the feature UI are implemented and independently reviewed. Native-launch fixtures with synthetic executables cover all three tools without model requests. Unique per-turn verdict paths prevent late prior output from satisfying a later turn. Regressions verify immutable checkpoints including operator overrides, owned process-group cleanup, explicit verification-log truncation and existing-PR summary refresh. Reviews also closed human-required pass results, selected-branch effects, unsuccessful native result reconciliation, crash-safe repair targets, durable operator reconciliation, malformed JSON cache invalidation and stage-scoped artifact presentation. The local test web server serves the new pipeline routes successfully; protected native processes remain alive. No final pipeline or whole-goal success is claimed yet.

Final local `npm run check` passes all 464 backend tests, ESLint, formatting, the 600-line gate and the production build. Alternate property seed `173205` with 300 runs passes 24/24. The final full production browser suites pass 130/130 in both Chromium and WebKit. The owned web process was restarted on port 4380; HTML deep links, pipeline/provider APIs and favicon respond successfully, while protected native processes remain alive. The [final remote matrix](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/actions/runs/34068255525) passes all six jobs at `5b3ab20`: Linux/macOS with Node 22/24, plus Chromium and WebKit. Native argument parsing was checked offline for installed Codex/Claude; all three adapters have synthetic end-to-end launch coverage. No paid model request or external pipeline PR was performed.

## Whole-goal acceptance

All requested phases are complete: feature-oriented refactor and deduplication, English first-party code with explicit locale boundaries, automated 600-line limits (380 files), blackbox/property/matrix tests, shared repository MCP memory, OpenRouter/Z.ai provider adapters, chat context/subagent/activity presentation, compact user bubbles, and native pipelines/profiles adapted from the user-owned reference. AgentPier's existing dark/orange style and native Chat/Terminal remain in use.

The implementation is committed on origin/main. The final documentation records the verified implementation commit rather than claiming paid inference, a global installation, a real remote PR or a Mac-mini deployment. The local web server is available on port 4380; protected native launchers remain alive.
