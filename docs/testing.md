# Testing AgentPier

Tests are organized by the invariant they exercise. Temporary profiles, repository fixtures and local application servers must never use the developer's real `.data`, CLI profiles, credentials or tmux sessions.

## Test strategies

| Strategy    | Directory           | What it proves                                                                                                                                                                                          |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Property    | `tests/property`    | Route identity round trips, invalid encoded IDs, Unicode name preservation, control/length rejection, HTTPS host normalization, URL confusion rejection and cross-host clone isolation.                 |
| Matrix      | `tests/matrix`      | Native argument and profile configuration across CLI, launch mode, local/managed profile and login/work; API-key login restrictions; Shell isolation; platform/architecture/npm installer availability. |
| Blackbox    | `tests/blackbox`    | Public HTTP persistence across restart, origin and malformed-input boundaries, secret redaction, private file exclusion and an isolated Shell lifecycle.                                                |
| Unit        | `tests/unit`        | Parser, route, security and pure runtime contracts, with inert text fixtures where needed.                                                                                                              |
| Integration | `tests/integration` | Real filesystem persistence, native adapter protocols, isolated subprocesses, local HTTPS Git transport and HTTP/WebSocket boundaries.                                                                  |
| Browser     | `tests/browser`     | User-visible flows, keyboard and pointer interaction, mobile layouts, deep links, terminal transport and reconnect.                                                                                     |

Run a strategy directly:

```sh
node scripts/test.mjs unit
node scripts/test.mjs integration
node scripts/test.mjs property
node scripts/test.mjs matrix
node scripts/test.mjs blackbox
```

Run all Node strategies together:

```sh
npm test
```

## Reproduce and shrink a generated failure

`tests/helpers/property.js` configures fast-check with seed `20260906` and 100 runs by default. Individual properties can request a smaller count for more expensive operations. Shrinking remains enabled: a failure includes its seed, replay path and minimized counterexample.

```sh
FC_SEED=123456 FC_RUNS=500 node --test tests/property/*.test.js
```

Replay exactly one failed property using the seed and path printed by fast-check:

```sh
FC_SEED=123456 FC_PATH='0:1:2' node --test \
  --test-name-pattern='generated public session' tests/property/routes.test.js
```

The path above is illustrative; use the actual failure's path. Restrict replay to the affected test because a path belongs to one property's generated values. `FC_RUNS` accepts 1–10000. A failure should become a targeted regression when it reveals a stable edge case, while the generated property remains in place.

Generated tests assert observable invariants rather than reproducing parser regular expressions. A valid route preserves its identity; an invalid clone origin cannot create a destination; secrets do not occur in public metadata or error messages. All credential strings are inert fixture values. Invalid clone properties fail validation before Git or network activity.

## Isolated application fixture

`tests/helpers/application.js` exports `applicationFixture(t)`. It starts the real application on a loopback ephemeral port with separate temporary `home` and `data` directories. Its request helper sends the correct same-origin header by default and supports deliberate foreign or absent origins. `restart()` closes the entire application and creates a new instance over the same fixture data.

Cleanup stops only sessions from this application's private store, closes application resources, kills only the tmux server whose socket is derived from the fixture's unique data directory, and removes that socket directory and the fixture files. It never targets the default tmux server. Cleanup is registered before startup completes and is idempotent. Explicit fixture disposal is available for cleanup assertions.

The Shell lifecycle test launches a local shell with the fixture's empty home. It exercises HTTP creation, restart persistence, rejection of deletion while running, explicit stop and deletion. It sends no shell input and invokes no coding model. The helper requires Node, Git and tmux prerequisites used by the application itself.

## Matrix interpretation and remaining gaps

The installed Codex reload compatibility test is opt-in:

```sh
AGENTPIER_TEST_CODEX_BIN=/absolute/path/to/codex node --test tests/integration/codex-remote-reload-native.test.js
```

It starts the real TUI and owned app-server in disposable profiles on a private tmux
socket, using only a synthetic loopback model provider. Both normal and YOLO sessions
must retain their conversation, model, permissions and attachment access across a
reload, then accept a message through the Chat HTTP endpoint without a hook receipt.
Without the executable variable these cases are reported as skipped.

The launch matrix exercises actual `AccountStore` commands and generated profile configuration. It does not start Codex, Claude Code or OpenCode, and does not prove that a remote provider accepts a model, endpoint or entitlement. Provider-specific matrices and isolated MCP tests cover those contracts separately.

The platform matrix checks the installation availability policy for macOS/Linux/Windows, ARM64/x64/ia32 and npm presence. It does not execute native binaries on simulated platforms. Run the blackbox suite on real macOS and Linux CI workers; an in-process platform parameter is not cross-platform runtime evidence.

The new blackbox suite currently covers HTTP and process lifecycle. Existing WebSocket/browser suites still supply terminal transport, reconnect, keyboard, mobile viewport and accessibility coverage. No generated suite authorizes global installations, real credentials or paid model calls. Live provider checks must remain separately opt-in and report skipped prerequisites truthfully.

Run `npm run check` in a fresh checkout: it builds the frontend before HTTP document tests execute. If running `npm test` or `npm run test:integration` directly, first run `npm run build`; pure strategy suites do not require generated assets.

## Browser fixtures and shared setup

Playwright discovers `tests/browser/*.spec.js`. `npm run test:e2e` starts a disposable application at `http://127.0.0.1:4389` after a production build. Its temporary home and data directory are removed on shutdown. Set `TUIUI_TEST_URL` only when intentionally using a separately owned fixture Vite/application server. These suites intercept API and terminal traffic; `live.spec.js` instead starts its own isolated application and inert shell/transcript fixtures. Neither mode authorizes interaction with real coding sessions.

`terminal-viewport.spec.js` simulates mobile visual-viewport height and offset changes in Chromium and WebKit, verifies terminal row resizing and toolbar visibility, and checks cleanup when switching views or returning to desktop. `terminal-touch-scroll.spec.js` also covers native Chromium swipes and pinch zoom. These fixtures do not open a real device keyboard; use a phone to confirm browser-specific keyboard animation and focus behavior.

```sh
npm run build
npm run test:e2e
AGENTPIER_TEST_BROWSER=webkit npm run test:e2e
# Optional externally owned fixture frontend:
TUIUI_TEST_URL=http://127.0.0.1:5188 npm run test:e2e
```

Install Playwright browser binaries as development prerequisites. To keep them inside this checkout, use `PLAYWRIGHT_BROWSERS_PATH=.cache/playwright npx playwright install chromium webkit` and set the same variable on test runs. This installs test browsers, not coding CLIs or background services.

Concurrent local Playwright invocations need distinct `AGENTPIER_TEST_PORT` values and `--output` directories. Each invocation clears its output directory at startup; sharing it can delete another run's active trace files.

`tests/helpers/repository-browser.js` shares the repository feature state machine across access, clone and discovery scenarios. Unknown API requests fail explicitly, so a newly introduced endpoint cannot silently succeed with an empty object. Other features keep their specific fixtures because their state transitions differ. Browser fixtures must not replace failing assertions with permissive default responses.

Chat fixtures must mock both HTTP and the chat WebSocket using `mockChatStream`; an HTTP-only fixture otherwise connects its invented session ID to the real test backend and can show unrelated errors. For geometry checks, read related bounds in one browser evaluation and retry the complete invariant after viewport changes. To test concurrent operations in two tabs, queue sequential pointer clicks behind a shared lock instead of racing mouse actions across pages.

Configure a scenario's initial fixture state before navigating. A setup-only reload can interrupt the first authentication request before the application has initialized; retain reloads when reload behavior is itself under test.

Reproduce asynchronous backend races with explicit gates around the relevant handoff, rather than sleeps. Upload retry coverage holds an older directory-preparation pass while admitting a new attempt, then verifies that receiving bytes waits for the pass that prepares its parent. Native filesystem failures retain operation and errno in the server-side error cause; HTTP responses continue to expose only the public error contract.

CI repeats the WebKit model resize, model error polling and two-tab upload cases five times without retries. Every run must pass. Failure artifacts include Playwright traces as well as screenshots; inspect a downloaded trace with `npx playwright show-trace path/to/trace.zip` before classifying a failure as flaky. To repeat those cases locally:

```sh
AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/model-control.spec.js tests/browser/chat-upload-recovery.spec.js --grep 'two tabs retry|model field.*390x500|model errors remain' --repeat-each=10
```

The HTTP API, image and preference integration suites share `applicationFixture`. Tests that stub public session listings cannot affect its cleanup: it captures the original fixture-owned listing method at startup. Repository integration scenarios share a temporary store and local authenticated HTTPS Git fixture; their credential, clone and discovery assertions live in separate files. Specialized transport fixtures retain their own setup when lifecycle semantics differ.

## Automated CI matrix

The Verify workflow runs once per pull-request revision and on pushes to `main`.
Feature-branch pushes and release tags do not start a duplicate test matrix;
release tags retain their dedicated packaging and installation checks. A new
pull-request revision cancels the obsolete Verify run for that same PR. Main
verification is not interrupted. The Secrets workflow still scans branch pushes.

| Job                       | Workers                                                 | Required checks                                               | Evidence and artifacts                                                                                 |
| ------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Static checks             | Linux, minimum supported Node                           | Formatting, ESLint, module-size/import checks, frontend build | Fail on warnings or formatting drift; retain build output on failure.                                  |
| Node contracts            | Linux and macOS, minimum supported and current LTS Node | Unit, integration, property, matrix and blackbox strategies   | Install Git, tmux and OpenSSL as runner prerequisites; preserve test logs and fast-check seed/path.    |
| Browser contracts         | Linux Chromium and WebKit; optional local macOS Chrome  | Full browser suite against a fixture-owned frontend           | Preserve failure screenshot, trace and reporter output; include desktop and existing mobile scenarios. |
| Extended generated checks | All backend CI workers                                  | 300 runs with recorded seed `173205`                          | Reproduce failures with their exact seed/path before adding a regression.                              |

CI must use disposable homes and independent data directories. Cache dependency downloads, never generated credential files or test profiles. Mocked platform selection is useful contract coverage but does not replace actual Linux/macOS subprocess runs. External provider checks, CLI installations and tests with real credentials remain separate opt-in jobs; a skipped prerequisite must be reported as skipped rather than passed.

## Nightly quality and mutation pilot

The separate **Nightly quality** workflow runs on the default branch at 01:23 UTC
(02:23 CET / 03:23 CEST) and can also be started with **Run workflow** on a selected
branch. It uses one Linux worker with Node 24. The existing pull-request Verify
matrix is unchanged; mutation testing is not part of `npm test` or `npm run check`.

Each nightly run first executes `npm run check`. Only a successful baseline permits
the additional checks: three property seeds with 1000 runs each, ten repetitions of
chat delivery/recovery and upload recovery integration tests, and finally the
Stryker mutation pilot. Recovery and mutation checks still run if an earlier extra
check fails, while the workflow retains that failure. All fixtures remain isolated;
these checks do not use real CLI sessions, credentials or paid provider calls.

Stryker mutates three modules: archive path/ZIP entry validation, MCP tool policy
and pipeline graph navigation. `stryker.config.json` explicitly lists the selected
tests. This is a pilot score for that selection, not a measure of the entire test
suite or application. The TAP runner uses the existing `node:test` files and
selects tests at file granularity. Two workers bound concurrency, individual
mutations have timeouts, and the CI mutation step has a 15-minute budget.

The pilot pins Stryker 9.6.1: Stryker 10's Babel 8 dependencies require a newer Node
minimum than this project's documented 22.13. The `typed-rest-client` dependency's
`qs` override keeps Stryker's development-only dependency tree on the patched 6.16
line. Stryker and its TAP runner are not needed by installed production instances.

Run the same pilot locally after installing development dependencies:

```sh
npm ci
npm run build
FC_SEED=20260906 FC_RUNS=100 npm run test:mutation
node scripts/mutation-summary.mjs
```

Build first because the selected integration tests start the application. Stryker
works in a disposable `.cache/stryker-tmp` copy and writes reports under
`coverage/mutation/`; both locations are ignored by Git, lint and formatting.
Runtime data, environment files and nested worktrees are excluded from the copy.
Runs are full rather than incremental so changes to shared helpers and dependencies
cannot leave stale mutation results in the pilot.

The Actions summary lists every check outcome and mutation counts per module.
Download the **mutation-report** artifact (retained for 14 days) and open
`index.html` for source-level findings; `mutation.json` supports further analysis.
A missing report is reported explicitly rather than presented as a successful
score. Baseline failures, runner errors, failed stress tests and job timeouts fail
the workflow. Surviving mutants do not fail a score threshold during the pilot.

Review **Survived** and **NoCoverage** findings for meaningful missing assertions,
and turn confirmed gaps into focused tests in the normal suite. Some mutations are
behaviorally equivalent or change diagnostic wording without violating a contract;
do not add assertions or broad exclusions just to raise the score. **Timeout** is
counted as detected by Stryker, but should be reviewed separately from mutations
caught by assertions. Expand the pilot only after measuring its runtime and value.

## Pipeline contracts

Pipeline blackbox tests drive all three native CLI adapters with inert executables. A public HTTP lifecycle test uses an owned tmux session, temporary Git worktree, verdict, verification command, artifact and stage diff; it restarts the web application at a human gate and checks that no native turn is duplicated. Native account/provider matrices reuse actual launch configuration without paid requests.

Generated graph tests cover finite repair cycles and conditional routing; policy properties cover verdict severity and verification outcomes. Engine integration tests cover durable intents, exact native identities, late verdicts, operator overrides, usage waits, retries, selected-branch side effects and interrupted recovery. Verification tests exercise timeouts, bounded log metadata and owned descendant cleanup. Worktree tests retain the source checkout and reject unowned paths, dirty worktrees and unpublished commits; PR tests use local Git remotes and a synthetic GitHub CLI.

Desktop and mobile browser tests cover profile editing/launch, graph preservation, deep links, run actions, stage-scoped evidence, verification settings and read-only headless Chat/Terminal sessions. Actual installed CLI argument parsing is an optional offline check; live provider inference and external PR publication are not asserted by these fixtures.
