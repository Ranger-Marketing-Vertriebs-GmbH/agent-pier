# Native operations and remote interaction implementation plan

> **For agentic workers:** Use the subagent-driven-development workflow with explicit ownership and independent task review. The user authorized continuous autonomous execution. Preserve progress and verification in operations-progress.md.

**Goal:** Implement all six AgentRunner-inspired features as native, tested AgentPier functionality.
**Architecture:** Narrow audit, notifications, native request and operations services; existing launch and HTTP composition integrates them. Settings tabs and inline Chat controls preserve the UI.
**Tech Stack:** ESM JavaScript, React 19, Vite 8, Express 5, Node 22.13+, SQLite, Playwright, fast-check.
**Spec:** [operations-design.md](operations-design.md).

## Global constraints

- English first-party code/comments; German copy in locale modules. At most 600 lines per source/style/test file.
- Preserve actual native CLI TUI, Chat, dark/orange style, mobile layout and deep links.
- Automated tests own temporary resources and never operate existing sessions/projects. The user separately authorized target-machine dependency/service installation and small real provider checks after saving credentials; unrelated global installation or paid inference remains outside scope.
- macOS/Linux and Node 22/24 verification. No secret-bearing audit/push metadata.
- Root owns shared application/router/navigation integration unless explicitly delegated. Workers do not revert others' changes or commit shared unfinished work.

## Task 1: Baseline, contracts and reference review

- [x] Verify clean baseline `f968cd5` and run `npm run check` (464 passing).
- [x] Inspect reference implementation and current native/operations/UI boundaries independently.
- [x] Record six-feature design and shared contracts without copying reference implementations.
- [x] Record exact final native capability and operation portability decisions in research reports.

## Task 2: Audit and event delivery foundation

Files: `server/features/audit/*`, `server/application/operations-events.js`, `server/http/routes/audit.js`, focused unit/property/blackbox tests. Root owns this task and shared composition.

Interfaces: `AuditStore.append(event)`, `.list(filters)`, `.export()`, `.close()` as specified; event sink accepts typed native/session/pipeline events after durable state transitions. GET `/api/audit` uses page/action/outcome/sessionId/projectId filters.

- [x] Write durable restart, stable pagination, SQL/filter rejection and metadata-whitelist tests; run `node --test tests/integration/audit.test.js tests/property/audit.test.js` and observe failures.
- [x] Implement private WAL storage and explicit HTTP/internal event mappings; no raw request/native text capture.
- [x] Prove successful and failed real API mutations appear correctly and reads do not create activity noise.
- [x] Run focused tests, lint/format, review the diff independently and fix confirmed findings.

## Task 3: Diagnostic and data operations

Files owned by operations worker: `server/features/operations/*`, `scripts/operations.mjs`, operation-specific HTTP router, docs and tests. Coordinate release subtask separately inside that folder. Consumes existing data stores read-only plus audit append/snapshot hooks.

- [x] Implement Doctor's shared CLI/HTTP report with bounded inert subprocess seams; test missing/healthy/error/platform/project cases.
- [x] Implement logical backup planning, component snapshot/manifest, owned archive listing/download and optional encrypted credential capsule.
- [x] Implement inspect then fresh-target restore, project remapping, historical-only sessions/runs and revoked imported capabilities.
- [x] Test SQLite concurrent writers, archive traversal/links/duplicates/expansion, corrupt checksums/schema, Unicode archive content, wrong passphrase/tampering, successful project remapping and source preservation.
- [x] Verify Unicode filesystem paths and reject duplicate-target/unmapped-project collisions without creating a target (`tests/blackbox/restore-project-mapping.test.js`).
- [x] Open a restored temporary application; prove memory revisions survive while native sessions and old deliveries do not restart.
- [x] Verify restored pipeline/profile equality, verification remapping, source memory preservation and zero recovered sessions in the real restored-application fixture.
- [x] Review implementation and CLI/HTTP evidence independently before completion.

## Task 4: Versioned releases

Files owned by operations worker: release-specific modules under `server/features/operations`, `scripts/release*`, service adapter changes and `.github/workflows/release*` when needed. Root reviews service changes against protected-session requirements.

- [x] Define version/platform/schema manifest and immutable release layout with stable dataDir and launcher.
- [x] Build an actual relocatable release artifact path, stage/check/activate/rollback commands and HTTP operations.
- [x] Test bounded downloads/extraction, wrong hashes/layout/platform, health failure automatic rollback, schema-incompatible rollback refusal and referenced-release retention.
- [x] Prove a real synthetic tmux session and an old-release helper survive update/rollback using isolated service adapters; never operate the real installed service.
- [x] Document installation/update/rollback on Mac mini/Linux; independent review covering actual deployable path, not just disabled source-checkout UI.

## Task 5: Native Chat request bridges

Files owned by native worker: `server/features/requests/*`, per-launch hook/plugin/proxy entrypoints, necessary narrow native-binding/session changes, request HTTP router and native tests. Root integrates into application launch/cleanup. Consumes typed audit/notification event sink.

- [x] Finalize Codex TUI remote bridge for complete questions and permissions; validate offline installed CLI capabilities and exact structured native response contracts.
- [x] Implement RequestBroker occurrence ownership, revisions, live connection/epoch checks, typed answer validation, exactly-once claim/delivery and Terminal handoff.
- [x] Implement Claude permission/question hooks and OpenCode TUI plugin replies using existing profile/launch isolation.
- [x] Test all three CLI paths with real synthetic hook/plugin/proxy transports; duplicate/racing/stale/identical-repeated prompts, multi-question/free-text/multi-select, disconnect/restart/timeout and cleanup.
- [x] Matrix local/managed accounts, default/permissive launch, work/login/shell/headless; preserve Terminal and avoid mutations of existing real sessions.
- [x] Independent code/capability review; unresolved Codex questions cannot be labeled complete.

## Task 6: Web Push backend and PWA

Backend root ownership: `server/features/notifications/*`, notification HTTP router and lifecycle observer. Frontend worker owns public PWA assets/service worker and browser notification controls.

Interfaces: GET `/api/notifications`, POST `/api/notifications/subscriptions`, DELETE `/api/notifications/subscriptions/:id`, POST `/api/notifications/test`; return public capabilities/settings/device summaries only. Final exact schemas are recorded before UI integration.

- [x] Add maintained Web Push dependency locally; validate VAPID/subscription payloads and external HTTPS delivery boundary with tests.
- [x] Implement durable occurrence deduplication, closed-browser lifecycle/gate/request observation, timeout/error/expiry handling, test notification and revocation.
- [x] Implement manifest/icons, minimal public offline shell, strict service-worker cache boundary and safe notification deep links.
- [x] Test a controlled encrypted push exchange and server persistence/error cases; browser tests cover opt-in only, refusal, failed server save, retry, revoke and unsupported/offline states.
- [x] Independently review subscriptions, no-content payloads and private cache exclusion.

## Task 7: Native AgentPier UI

Frontend worker owns `web/features/{operations,notifications,requests}`, settings tab/nav integration, locale modules and browser feature fixtures. Root delegates exact shared navigation files to this worker while implementation runs.

- [x] Add all five deep-linked Settings sections while retaining the existing directory settings form.
- [x] Add doctor results/remedies, backup plan/create/list/download/inspect/fresh-target restore, release check/stage/activate/rollback and paginated/filterable audit view.
- [x] Add native request-keyed Chat forms with all questions/options, error/stale/outcome-unknown state and Terminal handoff. Do not answer by submitting ordinary chat text.
- [x] Test desktop/mobile geometry, focus/keyboard, reload/history, pending actions, conflicts, duplicate clicks and failed requests against strict API fixtures.
- [x] Capture representative synthetic mobile/desktop views and independently review actual API contracts.
- [x] Complete root visual signoff on representative final mobile/desktop provider and operations views.

## Task 8: Whole-goal verification and integration

- [x] Complete blackbox/property/matrix coverage for all six features and cross-feature backup/update/request/push behavior.
- [x] Run the latest `npm run check`: lint, formatting, structure, production build and 622/622 backend tests passed.
- [x] Record alternative property seed evidence: the updated integrated run passed 34/34 suites with 300 cases at seed 173205.
- [x] Run full production Chromium: 152/152 passed.
- [x] Finish full WebKit:150 passed with two explicit platform-specific worker automation skips; Chromium152 passed.
- [x] Complete independent feature reviews and targeted correction verification, including Codex owned-group cleanup, permission scope, restore boundaries, Linux service environment and installer health.
- [x] Audit implementation and verification requirements; the final isolated Z.ai Coding Plan request closes the provider verification item below.
- [x] Update feature/install/testing docs and actual evidence; native smoke, synthetic transport and physical-device boundaries are distinguished.
- [x] Commit/push and pass Linux/macOS × Node22/24 plus both browser CI jobs at7988ed5; also pass all four release-package platforms.
- [x] Restart only the owned local web process, verify built routes and preserve user sessions.
- [x] Close the implementation and verification work after a successful isolated OpenCode request through Z.ai Coding Plan; record the regular API credit limitation without changing existing account configuration.

## Added task 9: Central access selection

The user extended the same goal before entering provider credentials. Follow [provider-connections-design.md](provider-connections-design.md): central OpenRouter/GLM connections, independently selected CLI and compatible native account/provider access, per-session model and start mode, private generated profile isolation, persisted history, backward-compatible existing provider accounts, metadata/encrypted-key portability, and HTTP/browser/matrix/property coverage. Root integrates the provider resolver, state/router/audit and nativeModelId validation. Run small real provider tasks only after the user saves keys in the new UI.

- [x] Implement central connection CRUD, isolated launch resolution and compatible native-account ownership, preserving legacy provider profiles.
- [x] Verify central connection backup/restore, history resolution, all nine provider/CLI launch configurations and key-redaction properties (66 focused tests).
- [x] Integrate shared lifecycle/state/router/audit and native per-session model validation.
- [x] Verify the final key rotation/deletion preparation lease with four real HTTP regressions and independent review.
- [x] Include central-access UI in the passing full Chromium suite.
- [x] Finish full WebKit verification and user credential entry.
- [x] Run authorized small live OpenRouter and Z.ai provider checks in isolated projects; record actual results and clean up owned sessions.
- [x] Verify the saved GLM key through the distinct Coding Plan product: actual OpenCode reply and automatically bound Chat succeeded; the original regular API connection remains unchanged.

## Added task 10: Target installation and final real use

Exercise the reusable installer on the user's designated Mac mini, install missing prerequisites there, configure its user web service and a dedicated private Tailscale identity/Serve endpoint. Give the user the authentication URL when required. Keep existing host Tailscale services, local projects and native sessions intact. Test the final local instance in isolated projects; installer/target defects belong to this goal. Record concrete verification without publishing private host addresses or credentials.

- [x] Implement reusable private-runtime installer and explicit dependency/service options; verify initial health failure and session-preserving release switching in fixtures.
- [x] Install and verify on the designated Mac mini, including automatic tmux installation and the web user service. The coding CLIs remain absent and no account/secret migration is claimed.
- [x] Authenticate the dedicated private Tailscale identity and configure HTTPS Serve on port 443.
- [x] Verify actual target HTTPS health from the MacBook, controlled shell input and web-restart survival, then remove the owned test session. Preserve existing host identity/services and user sessions.
- [x] Verify bundled Node 22.22.2, native PTY, tmux, Git and database diagnostics; record [target evidence](../research/target-install-verification.md).
- [x] Fix aliased package output and all 13 symlink-aware entrypoints; pass 72 affected tests, independent review and fresh actual packaging before target retry.

- [x] Activate1.0.1 through the target HTTP update job, verify an owned shell survives, retain immutable1.0.0 and confirm private HTTPS health.
