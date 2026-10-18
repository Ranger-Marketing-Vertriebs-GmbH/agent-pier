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

With `AGENTPIER_TEST_TIMEOUT_MS` (CI and local checks set it) every test file gets that
per-test ceiling. A file whose tests need longer, such as a native package build or
real CLIs in the matrix, declares its own in its first lines,
`// test-runner-timeout-ms: 600000`, and `scripts/test-runner.mjs` runs it in its own
class with the longer ceiling. Load-sensitive checks assert outcomes, not wall-clock
ratios: a step that must not wait is given a poll too long for any test, and race
tests interleave the competing step deterministically through a test seam.

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

Cleanup stops only sessions from this application's private store, closes application resources, kills only the tmux server whose socket is derived from the fixture's unique data directory, and removes that socket directory, the `/tmp/agentpier-*` socket folders of its local brokers (requests, session MCP, SSH, memory, AgentBus) and the fixture files. It never targets the default tmux server. Cleanup is registered before startup completes and is idempotent. Explicit fixture disposal is available for cleanup assertions.

`npm test` and the other strategy scripts give every run a private temp folder (`/tmp/ap-XXXXXX`, set as `TMPDIR` for the test files) and remove it afterwards, so a leaked fixture cannot fill the shared temp folder; a test that lists a huge temp folder slows down for everyone. The folder stays short because Unix socket paths built inside it must fit the 104-byte limit on macOS. Caches meant to outlive a run, such as the downloaded MCP Python toolchains, use `AGENTPIER_TEST_SHARED_TMPDIR`, the original temp folder. Test files still remove what they create, so direct `node --test` runs stay clean too.

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

Two activity checks are opt-in as well. The first starts the installed Codex through
the request bridge in the same isolated way and checks that its turns reach the
session activity; the second runs the installed Claude Code in a temporary HOME on a
private tmux socket against a local mock of the Messages API (no account, no model
calls) and checks the activity hooks for a turn, a background shell, Esc and exit:

```sh
AGENTPIER_TEST_CODEX_BIN=/absolute/path/to/codex node --test tests/integration/codex-activity-native.test.js
AGENTPIER_CLI_HOOK_CONTRACT=1 node --test tests/integration/claude-activity-hooks-contract.test.js
```

The GitHub MCP server contract for agents is opt-in as well. It starts the pinned
`github-mcp-server` with each level's arguments against a fake GitHub Enterprise API
on loopback (`GITHUB_HOST=http://127.0.0.1:<port>`), lists the tools of both levels,
calls one with a test token and checks that the token never appears in a result or
the server's log output:

```sh
AGENTPIER_GITHUB_MCP_BINARY=/absolute/path/to/github-mcp-server node --test tests/integration/github-mcp-contract.test.js
AGENTPIER_GITHUB_MCP_CONTRACT=1 node --test tests/integration/github-mcp-contract.test.js
```

The second form downloads and checks the pinned release into a temporary folder first.
Without either variable the test is reported as skipped.

The Deepgram live dictation contract is opt-in too. It streams a second of a quiet tone
through `DictationService` to Deepgram's real live endpoint and expects a clean
close after `CloseStream`. It uses only a key of its own, never a key stored in
AgentPier, and is reported as skipped without one:

```sh
AGENTPIER_DEEPGRAM_TEST_KEY=... node --test tests/integration/dictation-deepgram-live.test.js
```

The launch matrix exercises actual `AccountStore` commands and generated profile configuration. It does not start Codex, Claude Code or OpenCode, and does not prove that a remote provider accepts a model, endpoint or entitlement. Provider-specific matrices and isolated MCP tests cover those contracts separately.

The platform matrix checks the installation availability policy for macOS/Linux/Windows, ARM64/x64/ia32 and npm presence. It does not execute native binaries on simulated platforms. Run the blackbox suite on real macOS and Linux CI workers; an in-process platform parameter is not cross-platform runtime evidence.

The new blackbox suite currently covers HTTP and process lifecycle. Existing WebSocket/browser suites still supply terminal transport, reconnect, keyboard, mobile viewport and accessibility coverage. No generated suite authorizes global installations, real credentials or paid model calls. Live provider checks must remain separately opt-in and report skipped prerequisites truthfully.

Run `npm run check` in a fresh checkout: it builds the frontend before HTTP document tests execute. If running `npm test` or `npm run test:integration` directly, first run `npm run build`; pure strategy suites do not require generated assets.

## Browser fixtures and shared setup

Playwright discovers `tests/browser/*.spec.js`. `npm run test:e2e` starts a disposable application at `http://127.0.0.1:4389` after a production build. Its temporary home and data directory are removed on shutdown; Playwright stops the server with `SIGTERM` and a 5-second grace period so this cleanup runs. Set `TUIUI_TEST_URL` only when intentionally using a separately owned fixture Vite/application server. These suites intercept API and terminal traffic; `live.spec.js` instead starts its own isolated application and inert shell/transcript fixtures. Neither mode authorizes interaction with real coding sessions.

`terminal-viewport.spec.js` simulates mobile visual-viewport height and offset changes in Chromium and WebKit, verifies terminal row resizing and toolbar visibility, and checks cleanup when switching views or returning to desktop. `terminal-touch-scroll.spec.js` also covers native Chromium swipes and pinch zoom. These fixtures do not open a real device keyboard; use a phone to confirm browser-specific keyboard animation and focus behavior.

`touch-input-size-views.spec.js` and `touch-input-size-forms.spec.js` open the main views, dialogs and forms at 390×844 with touch and fail with a list of every visible text-entry control under 16px (the size below which iOS Safari zooms on focus) or any view that scrolls sideways. Add a step there when a new form or dialog appears.

`assistant-chat-composer-scroll.spec.js` types a wrapping draft into the agent and session chat composers and samples the transcript's distance from its bottom in every painted frame. It turns off CSS scroll anchoring, so Chromium fails like Safari (which has none) when a composer resize leaves the newest lines hidden.

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

CI runs in three tiers.

| Tier                         | Workflow     | Runs                                                                                                                                                                                                                                                                                                                                                                  | Required checks                                     |
| ---------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Pull request                 | `verify.yml` | Lint, formatting, structure checks and the frontend build. It also runs the node tests and Chromium specs the change affects (Linux, Node 24). Documentation alone runs no test, and the required jobs still report. A macOS backend job (Node 24) runs only when changed platform code is under test.                                                                | `backend (ubuntu-latest, 24)`, `browser (chromium)` |
| Merge queue                  | `verify.yml` | The same required jobs run the full node suite and all four Chromium shards, with one visible retry per failed file. Advisory: `backend (macos-latest, 24)`, `browser (webkit)` (five shards) and the Linux native filesystem matrix.                                                                                                                                 | `backend (ubuntu-latest, 24)`, `browser (chromium)` |
| Nightly and before a release | `full.yml`   | Everything: Linux and macOS × Node 22 and 24, Chromium and WebKit, the native filesystem matrices, the repeats, the extra property seeds, and the assistant runtime's fresh installs and native contracts. `release.yml` builds no package unless this suite passed on the release commit, and packages and publishes a tag only when the tagged commit is on `main`. | –                                                   |

A new pull-request revision cancels the obsolete Verify run for that same PR. The assistant runtime workflow runs its Linux jobs on pull requests that touch its paths; its macOS jobs run after the merge, nightly and before a release. `Assistant runtime (queue)` gates the merge queue for assistant paths. The Secrets workflow still scans branch pushes.

### Red advisory checks

Advisory jobs do not block a merge, but `release.yml` builds no package unless the full suite passed, so a red advisory job must be fixed before the next release. The advisory jobs are every job of `Verify`, `Assistant runtime` and `Assistant runtime (queue)` other than the required checks and the jobs that feed them (`select tests`, the Chromium shards): today `backend (macos-latest, 24)`, `browser (webkit)` and its shards, the native filesystem matrix, the assistant runtime fresh installs and native contracts, and `Assistant runtime (queue)`. Node 22 runs only in `full.yml`.

The `Advisory report` workflow (`.github/workflows/advisory-report.yml`, `scripts/ci-advisory-report.mjs`) runs when one of those workflows completes for a pull request or a merge group. It reads the run's job results through the API and keeps one comment on the pull request, found by a hidden marker: one section per workflow and event (pull request or merge queue) with the commit, a link to the run and a link to each failed advisory job, headed “fix before the next release”. Later runs update the comment instead of adding new ones; once every section is green it says that all advisory checks are green again. A pull request whose advisory jobs never failed gets no comment. A merge-group run reports on the pull request named in its `gh-readonly-queue/main/pr-<number>-<sha>` ref, also after that pull request has merged; its section reads “merge group containing #<number>”, because the group also contains the pull requests queued ahead of it, which the ref does not name. Runs that were cancelled, belong to an older revision than the pull request's head, or are older than the result already shown are ignored.

A red section stops counting once it is superseded. A pull request section whose commit is no longer the pull request's head is shown as an older revision; a workflow with a paths filter, such as `Assistant runtime`, may never run again for the new head. A pull request section is also cleared by a later green merge-queue section of the same workflow, which runs the same jobs. Merge-queue sections count until the next merge-queue run of that workflow. Each section lists at most 30 failed jobs and the number of the rest, and the comment stays below 60,000 characters (GitHub allows 65,536). Each report also writes a job summary. A comment that was deleted or rewritten by a concurrent report is merged or recreated; when the last of three attempts still does not stick, the report says “unverified” instead of failing the job. The reporter runs from the default branch, never checks out the pull request's code and is the only job with `pull-requests: write`; it creates no issue.

### Affected-test selection

`scripts/affected-tests.mjs` chooses the tests a change can affect, for fast pull-request feedback; the merge queue, nightly and release runs still run everything.

```sh
node scripts/affected-tests.mjs --base origin/main --json   # print the selection
npm run test:affected -- --base origin/main                 # run the selected node tests
```

It prints `{ mode, node, browser, reasons }`. `mode` is `all`, `selected` or `none`.

- **Node tests** are selected through a static graph. The graph follows imports, re-exports and dynamic imports of string literals across the repository. It also follows paths that tests name, such as a fixture they spawn or a screenshot they write. A server message catalog (`server/lib/i18n/de/<name>.js`) selects only the modules that read its namespace, plus the catalog tests. Any web or server catalog file and the `translation-lock.json` files also select the catalog-wide `i18n` unit tests, which load every catalog at run time; a lock-only change selects no browser specs.
- **Browser specs** are selected when they import the change, or when their file name contains the changed feature's name. The feature name comes from `web/features/<name>`, `server/features/<name>`, `server/http/routes/<name>.js` or a catalog of that name; `scripts/affected/browser-map.mjs` lists the extra names. Shared code selects every spec: `web/{app,components,lib,styles,startup}`, `public/`, `server/{app,application,http,lib}` and similar.
- **Everything runs** when any of these change: dependencies (not a bare version bump), `.github/workflows/verify.yml`, the test runners or their configuration, the build configuration or the selector. Everything also runs when the diff cannot be computed, a changed module does not parse, or no test imports or names a changed file. Above 60 % of a suite, that whole suite runs. Other workflows and `.github` files are inert.
- **macOS** is requested (`macos: true`) when a changed file other than a unit test or documentation either has `darwin` or `macos` in its path, or contains (case-insensitively) `process.platform`, `process.arch`, `os.platform(`, `darwin`, `macos`, `hdiutil`, `launchctl`, `diskutil`, `libSystem`, `.dylib` or `uname -s`.
- **Nothing runs** when only documentation that no test names has changed.

CI must use disposable homes and independent data directories. Cache dependency downloads, never generated credential files or test profiles. Mocked platform selection is useful contract coverage but does not replace actual Linux/macOS subprocess runs. External provider checks, CLI installations and tests with real credentials remain separate opt-in jobs; a skipped prerequisite must be reported as skipped rather than passed.

## Nightly quality and mutation pilot

The separate **Nightly quality** workflow runs on the default branch at 01:23 UTC
(02:23 CET / 03:23 CEST) and can also be started with **Run workflow** on a selected
branch. It uses one Linux worker with Node 24 and runs the Stryker mutation pilot;
mutation testing is not part of `npm test` or `npm run check`. The nightly baseline,
three property seeds with 1000 runs each and ten repetitions of chat
delivery/recovery and upload recovery tests run in the **Full suite** at the same
time. All fixtures remain isolated; these checks do not use real CLI sessions,
credentials or paid provider calls.

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
