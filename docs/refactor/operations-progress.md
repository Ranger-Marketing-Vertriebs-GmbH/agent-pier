# Native operations progress

Plan: [operations-plan.md](operations-plan.md). Spec: [operations-design.md](operations-design.md). Original clean baseline: `f968cd5`, with 464 backend tests.

## Current status

The six feature implementations and central provider access are integrated. The latest root `npm run check` passed lint, formatting, the 600-line structure gate, production build and **622/622 backend tests**. Full production Chromium passed **152/152**. Full production WebKit passed150 tests with two explicit platform-specific service-worker automation skips. All six final CI jobs passed for code commit7988ed5; all four platform release-package jobs also passed.

The actual Mac mini installation succeeded, including automatic tmux installation, the user web service and authenticated private HTTPS access through a dedicated Tailscale identity. A real target shell accepted input and survived a web-service restart; the owned test session was then deleted. The three coding CLIs are absent on the target, and no source accounts or secrets were migrated. See [target installation verification](../research/target-install-verification.md).

The central-provider preparation lease and all 13 symlink-aware entrypoint corrections are implemented and independently reviewed. Live provider results are recorded below. A final isolated OpenCode request through Z.ai Coding Plan succeeded with the saved GLM key, including automatic Chat binding. This closes provider verification without changing the original regular API connection or making billing changes. Implementation, verification and target installation are complete; target CLI/account setup remains the user's planned next step.

The existing feature checkout remains in place so running native sessions retain valid absolute helper paths. Automated tests use owned temporary projects, processes and data directories. Existing native sessions and user projects remain outside test interaction. No private target addresses, credentials or authentication tokens are recorded here.

## Ownership and reports

- Root owns shared composition, audit, push, final integration/reviews/CI and target deployment.
- Operations and central-provider worker delivered diagnostics, backup/restore, releases, installer and shared provider credentials: [operations report](operations-worker-report.md), [portability](../research/operations-portability.md), [central provider report](provider-connections-report.md).
- Native worker delivered the request broker, Codex proxy, Claude hooks and OpenCode plugin, plus independent push transport review: [native report](requests-report.md), [capability research](../research/native-requests.md).
- Frontend worker delivered operations, requests, notifications and PWA views and their scoped browser evidence; central-access UI is integrated and both full browser suites passed: [UI report](operations-ui-report.md).

Workers preserve other owners' changes and make no independent commits. New or unverified substitutes cannot close the goal.

## Audit, snapshots and event delivery

Audit uses private WAL storage, explicit metadata whitelists and bounded stable pagination. Public mutation tests cover successes and failures; ordinary reads do not produce activity noise. Import preserves valid ordered IDs/timestamps only into an empty target and rejects duplicate/private metadata before its atomic transaction.

The shared mutation barrier drains actual application route promises and pipeline transitions before backup capture. Four focused regressions cover draining, reentrant cleanup, expired asynchronous contexts and client disconnects. Operations routes acquire their own exclusive snapshot boundary. Independent native writers continue running; their database snapshots and history prefixes are explicitly per component.

Native requests emit typed events directly. Durable pipeline transitions and restart reconciliation feed the observer without requiring an open browser. Terminal activity uses existing bounded capture-pane observation only when push is enabled. Push uses maintained Web Push encryption, bounded HTTPS transport, public-address DNS enforcement, four concurrent deliveries, rotation-safe subscription updates and shutdown that does not begin queued work. Six independent local HTTPS tests decoded the encrypted payload and verified the VAPID signature, expiry and audience without contacting a real push service.

## Operations and native review corrections

The operations worker's focused suite passed 33 tests, including six existing service tests. It exercises live synthetic tmux/helper survival through backup and release activation/rollback, concurrent SQLite writers, encrypted fresh-target restore, archive limits, schema validation, platform boundaries and initial installer health confirmation. A real private production packaging run bundled official Node 22.22.2 and production dependencies, removed its source staging, then successfully imported the relocated application. No release was published or live installation activated by that proof.

Independent review corrections preserve an existing restore parent's permissions, remove native request metadata and capability hashes from imported data, validate embedded SQLite schema versions, expose imported AgentBus messages read-only, record asynchronous operation failures in audit, retain Linux user-service environment and require initial installer health. Root additionally canonicalized the operations-only data root for macOS system aliases without changing existing tmux identity.

Imported pipeline runs are history only: no gate/cancel/retry/PR action, no original-workspace artifact/diff/verdict reads and no recovery execution. Stored metadata, declarations and verification summaries remain readable. Native memory lifecycle fixtures use an inert Claude-shaped launch and preserve their original survival/revocation assertions.

The native worker verified real installed Codex TUI/app-server and isolated OpenCode TUI/plugin request flows with zero model turns. Claude uses actual synthetic hook subprocesses. Tests cover native/Chat answer races, all questions, stale replies, restart and Terminal handoff. The independent cleanup repro originally left a TERM-ignoring Codex descendant alive; the owned group keeper now closes it, including abrupt wrapper death. The exact independent repro was rerun successfully. Native additional-permission grants now display their actual turn scope.

Ordinary Chat/model actions are blocked while a native request is pending; Terminal control remains available. The UI implements matching guards. Scoped Chromium/WebKit results and synthetic screenshots are recorded in the UI report. Physical-device push delivery and locked-device display are not inferred from these fixtures.

## Central access selection

The user requested one central OpenRouter/GLM connection and independent CLI → compatible native account or shared provider → model/start-mode selection. Native accounts remain strictly bound to their CLI. Existing account-specific provider profiles remain compatible.

The backend stores each key once and uses a durable isolated managed profile per connection/source account/CLI/model. Existing history resolves through that actual account identity after restart or connection deletion. Native plugin/MCP settings are not copied; AgentPier prepares its own integrations against the selected profile. Metadata-only and encrypted-key backups preserve the connection identity appropriately.

The worker's scoped suite passed 66 tests, including all nine provider/CLI launch configurations, history resolution, strict ownership, HTTP CRUD, backup/restore and diagnostics. The central-key rotation property passed 300 cases with seed 173205. Root integrated lifecycle, state, router, audit and native model selection. The preparation lease now blocks key rotation/removal with 409 while an awaited launch is being prepared and releases after success or failure. Four real HTTP regressions failed with the lease disabled and pass with it enabled; independent review closed the finding. Both full browser suites subsequently passed.

## Verification history

Earlier broad integration failures are resolved, not current failures: the initial 545-test run exposed outdated synthetic Codex lifecycle fixtures, and the later 572/573 run exposed an atomic verification-receipt replacement race. A deterministic open/fstat replacement regression established the latter; the reader accepts its valid opened snapshot while still rejecting extra hard links. The latest root receipt subset passes 12/12. The updated integrated alternative-seed property run passed 34/34 suites with 300 cases at seed 173205. The earlier 615-test check included the preparation lease and subsequent packaging/entrypoint corrections.

The two original evidence gaps are now closed by `tests/blackbox/restore-project-mapping.test.js`: a real restored application preserves pipeline/profile definitions, remaps verification and Unicode filesystem paths, rejects duplicate-target and unmapped-project collisions without creating the target, preserves source memory and recovers zero native sessions.

The full WebKit repeat, final CI, live provider verification and final requirement audit are complete. Target installation evidence is recorded below and in its dedicated report.

## Authorized live provider and target work

The user saved local OpenRouter and GLM/Z.ai credentials and authorized small real tasks. Codex and Claude answered through both providers; OpenCode answered through OpenRouter, including automatic Chat after correcting its binding plugin export. Codex OpenRouter context was capped to the smaller published limit and confirmed in a fresh real native response. OpenCode regular Z.ai API rejected its request for insufficient balance/resource package; a subsequent isolated Coding Plan request using the same saved key succeeded, including its automatic Chat response. See [live-provider-verification.md](../research/live-provider-verification.md). No keys were exported and only owned temporary sessions/projects were used.

Root completed the authorized target installation and private remote setup. The reusable installer installed missing tmux and the web user service. The dedicated Tailscale identity is authenticated, HTTPS Serve uses port 443, and the MacBook reached the real target `/api/health` over HTTPS. A target shell accepted a controlled input marker and remained alive through a web-only service restart; only that owned test session was removed afterward.

Target Doctor checks passed for bundled Node 22.22.2, native PTY, tmux, Git and the checked databases. Codex, Claude Code and OpenCode are not installed on the target yet and await user configuration; no target coding-agent inference is claimed. Source secrets/accounts were not migrated. The [target report](../research/target-install-verification.md) records these boundaries without private connection details.

## Packaging and entrypoint corrections verified during deployment

The first actual output to `/tmp` exposed a private-folder check incorrectly applied to a user-selected artifact parent. Packaging now builds and smoke-checks inside owned staging, then publishes into the canonical existing parent without changing its permissions. Three regressions cover aliases, output links and preservation of an earlier artifact after failed smoke.

The first target installer invocation silently did nothing because Node canonicalized `import.meta.url` while `argv[1]` retained a symlinked checkout path. `isMainModule` now resolves both paths at all 13 affected scripts/helpers, preserving extra native helper flags and inert imports. Five new identity/subprocess tests and the affected 72-test suite pass. Independent review confirmed no duplicate dispatch or changed authority boundary. The fresh actual release package passed production dependency installation and relocated runtime smoke before the successful target retry.

## Version1.0.1 verification

The main implementation at348b897 passed all six CI jobs (Linux/macOS with Node22/24 plus Chromium/WebKit). Full local browsers passed152 Chromium and150 WebKit tests with two explicit platform-specific worker automation skips. The final native binding/context corrections pass a fresh622-test check and the alternative property seed passes34 suites. The1.0.1 target update job succeeded over the real application API, preserving an owned shell session and retaining immutable1.0.0. The final corrective code commit7988ed5 passed all six CI jobs: [verification](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/actions/runs/34104907021). All four OS/architecture release builds passed: [packages](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/actions/runs/34104920938). The final isolated Coding Plan verification closes the remaining provider item. The regular API balance rejection remains accurately recorded; no product or billing settings were silently changed.
