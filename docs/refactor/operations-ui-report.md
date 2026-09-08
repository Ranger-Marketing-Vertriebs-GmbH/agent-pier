# Operations UI implementation and verification

The six authorized capabilities are integrated into AgentPier's existing dark/orange workspace. No native fixture/session was launched and no protected application data was read for UI verification.

## Navigation and ownership

- `/settings` retains the existing default-directory form in `web/features/settings/DirectorySettings.jsx`. `SettingsPage.jsx` owns the shared section navigation; `web/features/operations/routes.js` parses `/settings/notifications`, `/settings/diagnostics`, `/settings/backups`, `/settings/updates`, and `/settings/audit`. `web/app/routes.js` and `App.jsx` connect these routes. Settings feature code is lazy loaded. Backups also exposes imported AgentBus history as a paginated, read-only view with explicit no-redelivery status; it stays hidden when no history exists.
- `web/features/operations` owns audit, diagnostics, backup planning, archive inspection/fresh-target restore, update staging/activation/rollback, confirmation dialogs and persistent job observation. Audit page/filter/high-watermark state and operation job IDs survive reload in deep URLs. Job polling retries reads after connection failure, never replays a mutation, and never infers activation success from a successful reconnect.
- `web/features/requests` owns occurrence/revision keyed native permission and question forms. Native option IDs and labels are preserved, all questions must be answered, multiple selection and free text are supported, secret questions use masked inputs without durable drafts, and an in-flight action cannot be submitted twice. Responding/unknown states cannot be repeated. The shared Terminal path remains available. Chat/model controls pause while a request is pending or its state cannot be read.
- `web/features/notifications` owns browser capability checks, installation, explicit permission/subscription registration, direct test delivery, device revocation and current-device state. `web/lib/i18n/de/{operations,notifications,requests}.js` and the narrow chat locale additions contain semantic German copy. Diagnostic and backup stable IDs have localized labels while native diagnostic evidence remains verbatim.
- `web/lib/useResource.js` is the former pipeline resource hook, promoted with mechanical pipeline imports. Its explicit `update` method invalidates older in-flight reads after a mutation so a poll cannot resurrect a answered request. Existing pipeline behavior remains covered by all 16 pipeline browser scenarios.

## PWA and privacy boundaries

`public/sw.js` precaches exactly six public files: `/offline.html`, `/manifest.webmanifest`, `/pwa-icon-192.png`, `/pwa-icon-512.png`, `/pwa-maskable-512.png`, and `/apple-touch-icon.png`. Cache Storage contains no application HTML, JS application chunks, API responses, session/chat content, provider keys, or authenticated state. Navigation falls back to the public offline screen only when the network fails. Non-GET, API and cross-origin requests are excluded; there is no background mutation queue, `skipWaiting`, `clients.claim`, or silent page reload.

The manifest preserves landscape availability for terminal use and provides ordinary, maskable and Apple icons derived from AgentPier's existing code-native logo. Production startup registers the worker; development does not automatically register it. A captured browser install prompt remains available when the user later visits settings, and is invoked only by clicking install. Browsers without an install prompt receive manual guidance.

Push permission is requested only from an explicit activation click. A persistent local UUID identifies the device; subscription secrets are not put into local storage or URLs. The UI claims activation only after the subscription is persisted server-side. Revocation removes the server subscription before the browser subscription, retaining a retry path on partial failure. Test delivery is an explicit action and its confirmation means sent, not independently observed by the device.

The worker accepts only known generic event kinds. Supplied titles, bodies and URLs are ignored. IDs are validated before building same-origin chat/run links; a notification only opens an application view and never approves a request. Existing exact-target tabs may be focused; unrelated tabs are not silently navigated away from unsaved work.

## Verification

All browser runs used strict API fixtures on owned Vite port 5188, with unique temporary output paths. No real native session or push service was contacted.

- Chromium: **31/31** passed, comprising 15 new operations/request/notification/PWA scenarios and 16 existing pipeline scenarios. Command: `TUIUI_TEST_URL=http://127.0.0.1:5188 npx playwright test tests/browser/operations*.spec.js tests/browser/native-requests.spec.js tests/browser/notifications.spec.js tests/browser/pwa.spec.js tests/browser/pipelines*.spec.js --output=/tmp/agentpier-operations-chromium-final --reporter=line`.
- WebKit: **29 passed, 2 intentionally skipped** with the same selection and `PLAYWRIGHT_BROWSERS_PATH=.cache/playwright CI=1 AGENTPIER_TEST_BROWSER=webkit`; output `/tmp/agentpier-operations-webkit`. Playwright's actual service-worker automation is Chromium-only; install and notification UI flows also execute in WebKit with capability fixtures.
- Following the final native-pending input guard, the affected chat, native requests and operations-management subset passed **19/19 in each engine** (`/tmp/agentpier-request-controls-{chromium,webkit}`). The canonical `model-control.spec.js` suite passed **9/9 in each engine** (`/tmp/agentpier-model-controls-{chromium,webkit}`).
- `node --test tests/unit/routes.test.js`: **7/7**, including all settings sections, invalid routes, durable job identity, audit filter round trips and bounded page/high-watermark inputs.
- Scoped ESLint passes. Source-size gate passes: every first-party source/test file is at most 600 lines. Prettier checked the UI/public assets and touched tests; promoted pipeline imports were formatted.
- A disposable real `createApplication` fixture on temporary port 51049 verified health version/instance identity, notification/audit/release shapes, backup planning, one completed backup job, owned archive download, raw binary upload, inspection, and a completed restore into a fresh temporary directory. All checks passed; the app was closed and fixture directories removed. No session was started and the running application's data directory was never switched.

Coverage includes conflicted native answers with draft retention, all-question validation, secret masking/reset, native-pending input guards, failed notification persistence and server-first revocation, explicit install and permission intent, actual public SW cache contents/offline behavior, notification content/target validation, audit high-watermark pagination/reload/filter reset, diagnostic opt-in/remedies, reviewed backup options, durable jobs/reload, mobile archive mapping/restore, staged releases, capability-disabled activation, failure status without false health success, and duplicate update mutation prevention.

## Screenshots

Synthetic data only, captured in `docs/screenshots`:

- `agentpier-operations-diagnostics-desktop.png`
- `agentpier-operations-backup-desktop.png`
- `agentpier-operations-updates-desktop.png`
- `agentpier-operations-notifications-mobile.png`
- `agentpier-operations-approval-mobile.png`
- `agentpier-operations-audit-mobile.png`

## Capability boundaries

Physical iOS Home Screen installation, APNs/other external push delivery and notification display while a device is locked require real-device validation with explicit permission. They are not claimed from mocked browser tests. iOS/iPadOS push requires a supported installed Home Screen web app; [WebKit's platform documentation](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) describes that boundary. [Playwright documents its Chromium-only service-worker automation](https://playwright.dev/docs/service-workers).

The UI does not invent deployment eligibility or rollback choices. Source checkouts expose server-provided setup requirements; the external operations helper owns restart, health/version verification and rollback. The UI observes its persisted outcome. Restore targets a fresh directory and requires explicit project mapping; it does not activate restored data or resume historical sessions. Diagnostics uses bounded inert checks; its explicit deep option means SQLite `integrity_check`, not a network or paid model probe. Unknown native request delivery remains a Terminal handoff situation, without an unsafe automatic retry.

The final imported-history addition and short (390×500) native-request layout are covered by **5/5 native-request/history tests in each engine** (`/tmp/agentpier-final-request-history-{chromium,webkit}`). Completion notifications use their own `session-completed` kind with generic “Antwort bereit” copy; `session-ended` remains reserved for an actually stopped session.

Notification follow-up additionally covers delayed initial browser reads racing a successful opt-in and retrying only the local unsubscribe after the server deletion succeeded. Final totals are 18 new browser scenarios; the earlier 31-case combined run predates three incremental regressions, whose scoped outcomes are recorded separately.

Final notification follow-up: **3/3 passed in each engine**, output `/tmp/agentpier-notifications-complete-{chromium,webkit}`. The service-worker content/target suite including `session-completed` passed **3/3 in Chromium** after the completion-kind correction. Scoped ESLint, Prettier and the 600-line structure gate all pass at final frontend freeze.

## Production WebKit fixture isolation

A production-only reload failure was traced to WebKit/Playwright network interception after the public service worker controls the page. A safe fixture-only API probe was intercepted before registration, then bypassed the page route after worker readiness and reload (zero route hits). The worker already excludes `/api` requests from its fetch handler; no private offline caching was involved.

`playwright.config.js` now blocks service workers for ordinary API-fixture contexts. `tests/browser/pwa.spec.js` explicitly enables them only for its two actual service-worker scenarios, preserving the real Chromium cache allowlist, anonymous offline navigation and generic push/deep-link tests. A complementary blocked-worker probe retained interception after reload with no controlling worker. Product registration behavior is unchanged.

The simulated install-prompt scenario uses the normal blocked-worker context on both engines. A production static preview reproduced the WebKit failure with whole-file worker permission; restricting the override to the two real-worker tests restored the install UI test (1 passed, 2 existing platform skips). No Safari install-prompt coverage was removed.
