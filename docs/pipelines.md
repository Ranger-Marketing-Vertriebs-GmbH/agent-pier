# Pipelines and task profiles

Pipelines run a task through reusable CLI stages such as implementation, review and verification. They use AgentPier's existing accounts and native Codex, Claude Code and OpenCode installations. No separate Docker runtime, provider-key store or CLI installation is required by this feature.

## Profiles

Open **Pipelines → Profiles** to create or edit a task template. A profile chooses an existing account, its CLI, permitted models and a default model, native permissions, role instructions and a kickoff prompt. Account selection also selects the configured provider and its credentials. An empty model selection leaves the account or native CLI default in control; it is not a claim that a particular model was confirmed.

Profiles can be enabled, disabled, duplicated and grouped by refinement, planning, implementation, review or maintenance. Built-in planner, implementer, code reviewer, security reviewer, conflict resolver, bug hunter and app tester profiles are editable starting points. Deleting or changing them persists across restarts.

Text parameters use `{{parameter_name}}` in the kickoff prompt. Standalone profile sessions validate required parameters and reject undeclared values before launch. Pipelines require enabled autonomous profiles without required parameters, because a pipeline supplies the overall task rather than an interactive parameter form. Role instructions are included in the native prompt.

Permission values retain each CLI's meaning. Selecting a permissive mode is an explicit configuration choice; a provider or driver error never widens permissions as a fallback. Native account/provider capabilities and context limits still apply. See [providers](providers.md) for endpoint and model restrictions.

## Build and start

1. Create a definition under **Pipelines → Definitions**. Add profile stages and arrange them in execution order.
2. Add verification or human approval after a stage when needed. A PR step is optional and authorizes publishing the run branch when that point is reached.
3. A review failure can return to an earlier stage with a finite repair budget from one through five iterations. The advanced graph editor preserves conditional routing that an ordered list cannot express.
4. Start a run with a task, an existing local Git repository and an optional base branch/ref. AgentPier creates a separate owned worktree and branch. It does not reset the original checkout or move its branch.

Each run freezes its definition and explicit profile settings. Later template edits affect future runs. Credentials remain in the existing account store and can be rotated; changing an account to an incompatible provider prevents subsequent turns from silently using another provider.

Open a run to see the current stage, attempt history, findings, usage and recovery actions. Every native turn has its own AgentPier session, with links to the familiar Chat and Terminal. Pipeline input is owned by the run; feedback is submitted through the pipeline action rather than typed into an active headless process.

## Outcomes and human decisions

The stage prompt specifies a private attempt-specific verdict path and the expected JSON structure: a `pass` or `fail` result, a summary, optional findings, artifacts and a `requiresHuman` flag. Completion requires the actual native turn outcome. An idle-looking terminal, an old verdict file or a successful-looking sentence is not sufficient.

A pass follows a pass edge, otherwise a default edge. A fail never follows a default edge. Verification, approval and PR effects apply only to the selected branch. On a bounded review loop, a failure containing only low-severity findings can advance; an explicit human-decision requirement always takes precedence. Missing or invalid verdicts get a bounded continuation opportunity, then require a human decision. Findings requiring a person and exhausted automatic repair loops remain visible at a gate.

Available actions depend on the current state: accept, override, feedback, loop back, retry, reconcile a late verdict, wait for a usage reset, resume now or abort. The run retains previous attempts and decisions. Retrying PR creation retries that side effect instead of rerunning the agent's implementation stage.

## Verification and evidence

Verification settings belong to a registered project under **Pipelines → Verification**. Commands are stored in AgentPier's data directory rather than taken from an agent-editable gate file in the repository. Configure each command's name, timeout and whether a failure blocks the stage. A configuration supports at most 20 steps with a combined timeout of two hours.

The exact plan is frozen for each gate attempt when used; edits can affect a later attempt but never rewrite an in-flight execution. Every step runs, even if an earlier one fails, and each has an individual timeout and a bounded tail of 8,192 log characters with an explicit truncation indicator. Blocking failures, missing execution and timeouts cannot become a successful verification result. Run details retain the plan, outcome and logs alongside stage diffs and declared artifacts.

Artifact reads are bounded and confined to the run's worktree and declared evidence. Credential directories, traversal and symlink escapes are rejected. Every accepted or overridden completed stage records a Git checkpoint. A diff identifies that recorded boundary; later repair attempts do not erase previous attempt records.

## Restart, cancellation and cleanup

Run state, attempt identity and native session identity are durable. A web-only restart reconciles the existing turn instead of launching another copy. Interrupted or ambiguous side effects become an actionable state; they are not silently reported as completed.

Aborting stops the pipeline's owned process groups and preserves the worktree. Group termination is not an operating-system sandbox: a program that deliberately detaches into a separate process group is outside that guarantee. Deleting a finished run is the separate cleanup action. Cleanup checks ownership and refuses active native processes, uncommitted changes and unpublished commits; preserve or publish that work first. The source checkout and unrelated directories are outside the removal operation.

An optional PR action uses the existing host-scoped GitHub credentials and GitHub CLI. It publishes the run's branch and opens or refreshes its PR; later completed stages refresh the branch and summary of that existing PR. It does not merge the PR or wait for downstream CI. No push or PR is performed merely because a run finishes without a PR step.

## Architecture and validation

The reference feature inventory and deliberate corrections are recorded in [the implementation contract](refactor/pipelines-plan.md) and the linked research inventories. Definition validation, execution state, native drivers, worktree ownership, verification, evidence reads and HTTP/UI presentation have separate modules. Tests use synthetic CLI processes, temporary repositories and isolated application data; live paid inference and external PR publication are not part of the automated checks.
