# Native requests implementation report

Owner: native request worker. No commits were made. Root owns application/lifecycle/router/shutdown composition and final repository checks.

## Delivered files and integration ports

- `server/features/requests/request-broker.js`: `RequestBroker({dataDir,sessions,onEvent})`, `.ready`, `.prepare`, `.list`, `.answer`, `.handoff`, `.discard`, `.close`.
- `server/features/requests/{wire,native-channel,request-validation,request-launch}.js`: bounded authenticated private transport, live occurrence protocol, typed input validation, isolated launch configuration.
- `server/features/requests/{codex-launch,codex-proxy,codex-protocol}.js`: actual native app-server/TUI launch and response arbitration.
- `server/features/requests/claude-hook.js`, `opencode-plugin.js`, `native-questions.js`: native hook/plugin question and permission adapters.
- `server/http/routes/requests.js`: `requestsRoutes({requests})`.
- `server/lib/i18n/de/requests.js`: German feature copy.
- Narrow `SessionManager.create` addition retains `nativeRequests` metadata for interactive work sessions.
- `scripts/smoke-native-requests.mjs` and `docs/research/native-requests.md`: actual native evidence and documented capability boundaries.

Call `await requests.prepare({id,account,cwd,launch,purpose})` after native bindings and only for normal interactive launch; skip trusted headless transforms. Pass its returned launch unchanged to `sessions.create`. Discard on failed launch and removal; close only the web broker during web shutdown. Existing native Codex/OpenCode helpers retain their native sessions and reconnect. A waiting Claude hook hands control to Terminal when the broker disconnects.

Public routes: GET `/sessions/:id/requests`; POST `/sessions/:id/requests/:requestId/answer` with `{expectedRevision,choice? ,answers?}`; POST the matching `/handoff` with `{expectedRevision}`. Responses are `{requests:[...]}`. Public form fields were coordinated with the frontend owner; UI mount uses `session.nativeRequests.enabled`.

`onEvent` receives `{action,resourceType:'request',resourceId,sessionId,kind,outcome,source,details:{kind,decision?}}`. Actions are request.created/answered/expired/handed-off. Decisions are allow/deny/answer/handoff. Native transport IDs, tokens and task content do not enter events.

## Verification

Failing-before-passing tests established missing transport/adapters, wrong remote URL shape, request replay, free-text option collisions, incorrect OpenCode remembered-permission scope, and loss of future native frames. All 52 native-request focused tests pass. The property suite also passed with `FC_SEED=173205 FC_RUNS=300`.

- `tests/integration/native-requests.test.js`: real Unix channel, concurrent duplicate submissions, stale/Terminal-resolved prompts, complete questions, handoff, disconnection and stable deduplicated web restart.
- `tests/integration/codex-request-proxy.test.js`: real authenticated WebSocket transport, native/Chat race, typed RPC answers, native auto-resolution and unknown-shape forwarding.
- `tests/integration/request-storage.test.js`: symlink rejection, second broker exclusion and unauthenticated native peer rejection.
- `tests/blackbox/native-request-routes.test.js`: public HTTP plus actual Claude hook subprocesses; unknown delivery cannot retry; service disconnect yields successful empty native handoff.
- `tests/unit/native-request-adapters.test.js`: complete Codex/Claude question contracts and OpenCode pending-state/client boundaries.
- `tests/matrix/native-requests-launch.test.js`: 22 tool/profile/mode and excluded launch combinations.
- `tests/property/native-requests.test.js`: arbitrary reply shapes, native ID/free-text round trips and metadata filtering with reproducible seeds.
- Native smoke passed using installed `/home/developer/.local/bin/codex` 0.153.4: actual TUI and app-server, synthetic Chat question, actual native Enter answer, stale Chat rejection, permission denial, zero model turns.
- Focused ESLint and Prettier checks passed before handoff; root must run complete integration and CI after composition.

## Review notes

The OpenCode executable was initially absent. With explicit permission, the unchanged ToolInstaller installed 1.18.29 into a private temporary data directory and home. Actual server/TUI/plugin smoke now verifies native Chat question/permission replies, Terminal answers, stale Chat rejection and zero model turns. The loader contract exposed a missing default export; a focused failing regression test established the defect before its fix. Temporary installation and owned test processes were cleaned up. Codex policy-amendment objects and specialized MCP elicitation forms deliberately preserve native Terminal ownership. New releases with different native APIs need updated capability tests; no CLI is globally installed or silently replaced.

Restore must omit the complete `requests/` runtime directory. Release cleanup must retain helper code used by live native sessions. Protected real PIDs and sessions were not inspected or controlled.

## Independent push transport review

Added `tests/integration/push-transport.test.js`: six tests passed against a temporary, certificate-validated local HTTPS server. Production Web Push encryption is independently decoded with Node ECDH/HKDF/AES-GCM primitives; ES256 VAPID signature, audience and expiration are independently verified. The test confirms metadata-only decrypted content and fresh encryption per send. Other checks cover no redirects, response bodies above 64 KiB, the actual 10-second total timeout, cancellation during server shutdown, and invalid inputs rejected before transport. No external push delivery occurs. Focused ESLint and Prettier passed. No production defect was identified in the reviewed push sender/network/validation modules.

## Isolated OpenCode installation and native smoke

`ToolInstaller.start("opencode")` used the production download/install/verification/publication path and reported success for version 1.18.29. Its npm prefix, cache, configuration, home, executable and activation link were entirely inside an owned temporary directory; no global profile installation occurred. `scripts/smoke-opencode-requests.mjs` records the repeatable native protocol test. The real TUI renders the injected native requests and the production plugin answers through its actual SDK client. The smoke owns its native session/server and blocks every model-turn endpoint.

Final follow-up verification: all 58 combined tests passed (52 native requests, six push transport); focused ESLint and Prettier passed. The OpenCode native smoke passed twice with exit code zero after tightening owned process-group cleanup. A process search restricted to the unique fixture path confirmed no remaining OpenCode fixture processes. The temporary CLI installation and the one residual cache directory from an earlier cleanup race were removed. A rare push test fixture issue was also corrected: Node ECDH can return a 31-byte private scalar, whereas VAPID requires its 32-byte padded encoding; a controlled leading-zero scalar reproduced the library rejection before padding was added to the fixture.

## Independent review corrections

Codex backend cleanup now uses a live detached group keeper and the existing `stopOwnedGroup` escalation. The wrapper awaits group cleanup; IPC disconnection kills that exact owned group if the wrapper dies abruptly. This avoids both a lost unreferenced escalation timer and signaling a recycled group ID after its leader exits. Three failing-before-passing subprocess regressions exercise native TUI exit, wrapper SIGTERM and wrapper SIGKILL with a TERM-ignoring descendant and an unrelated sentinel process. The actual installed Codex TUI also started through the new keeper and exited successfully on Ctrl-C without a model turn.

The additional-permissions native response grants `scope:turn`; its public option now retains `scope:turn` and the German label `Für diesen Turn erlauben`. The frontend owner added the matching scope label. A focused regression validates both public scope and display copy after request normalization. No native command/file approval scope was changed.
