# Assistant release qualification

Qualification on October 8, 2026 targets the managed assistant feature after merging
`origin/main` at `8f52a769`. Tests use disposable synthetic state on macOS arm64.
The existing private Telegram trial was not restarted or modified for this work.
This evidence supports review; it does not itself authorize deployment, release, or
a merge to main. The sections below are dated records of how the evidence developed;
where an earlier section was superseded, it says so and the "Current status" section
prevails.

## Current status (2026-10-09, after the review fixes)

- **Native contracts in CI:** the `Assistant runtime` workflow runs every deterministic
  native contract in its `native-contracts` job on Ubuntu and macOS (nightly and on
  pull requests touching assistants) and fails if any contract skips. The earlier
  "four-target native CI workflow" wording below described the runtime installation
  matrix, not the contract run. Linux contract results therefore come from CI, not from
  local qualification.
- **Browser suites:** the Chromium and WebKit CI failures noted at `21935d4f` were
  diagnosed and fixed (see "Browser fixtures" below). All `assistant*.spec.js` specs
  run in Chromium, WebKit and, at 820x1180 with touch, in the `tablet` project.
- **Review fixes:** the opt-in switch, the TLS-pinned Gateway transport, orphan
  reclaim, sealed and revocable snapshots, host backups, proxy-aware provisioning,
  Telegram hardening, natural-language team authorization, team coding requests and
  the write guard are documented in the
  [operating guide](assistant-gateway.md) and [runtime updates](assistant-runtime-updates.md).
- **Local validation:** `npm run check` passed 4,898 of 4,930 tests with 31 conditional
  skips; the single failure is the environment-dependent Unicode login-shell test in
  `tests/integration/shell.test.js`, which is unrelated to agents. The assistant browser
  specs passed 160 of 160 in Chromium and 160 of 160 in WebKit across the `desktop`
  and `tablet` projects.
- **Still open:** real Azure qualification (needs an endpoint
  from the owner), production deployment, team spend budgets (AGENTPIER-7), and
  Gmail, Microsoft 365, Google Calendar, Apple services and a sandbox. Every update
  path an installed user can take today is qualified locally on macOS arm64 (see
  [update paths installed users take](#update-paths-installed-users-take)); the
  native contracts and cross-version tests on the other architectures run nightly
  and before a release, and their first results are pending (see
  [native architectures](#native-architectures-2026-10-19)). Real Linux hosts
  (systemd, orphan reclaim) remain unqualified, see [Linux](linux.md).

- **Agent shell access (2026-10-12):** before a release, the four shell contracts
  (`assistant-shell-contract`, `assistant-shell-environment-contract`,
  `assistant-shell-changes-contract`, `assistant-shell-compiled-contract`) must pass
  without skips with `AGENTPIER_SHELL_CONTRACT_RUNTIME`; the `native-contracts` job
  runs them. Locally on macOS arm64 they passed 15 of 15.

- **Recorded end-to-end runs (2026-10-19):** a Telegram voice note through
  transcription to a delivered native reminder, and an owner-approved coding run that
  a lead's permanent member requested, with its result in the lead's chat, passed
  three times each on the pinned runtime; the `native-contracts` job runs both (see
  [Recorded end-to-end runs](#recorded-end-to-end-runs-2026-10-19-agentpier-173)).

## Deeper checks

| Area                  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                | Boundaries                                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native memory         | Two pinned Gateway contracts verify deletion/re-index/restart, model-reference switching and agent isolation.                                                                                                                                                                                                                                                                                                                           | Deterministic HTTP model; no semantic embeddings or erasure of historical transcripts/backups.                                                                                          |
| Native scheduling     | Nine native scheduler cases cover Berlin/New York DST, explicit timezones, 30-day downtime, restart, missed-run policy, backlog spacing and duplicate completion delivery.                                                                                                                                                                                                                                                              | Injected clock with real scheduler/SQLite; not an operating-system suspend or crash experiment.                                                                                         |
| Runtime update        | Two native cases verify activation and rollback after injected candidate validation failure for OpenClaw 2026.9.7 → 2026.9.8, 2026.9.8 → 2026.9.9, 2026.9.9 → 2026.10.3 and the skip update 2026.9.8 → 2026.10.3 (see below); a local throwaway variant covered the Node-only update 26.7.0 → 26.12.1 on 2026.10.3.                                                                                                                     | Earlier pairs ran on Node 26.7.0; the current runtime is Node 26.12.1. macOS arm64 locally; Linux x64 in the nightly `cross-version` job.                                               |
| Project identity      | Three real Git/ProjectMemory/ProjectRebind cases cover git initialization, automatic rebind and duplicate-project merging.                                                                                                                                                                                                                                                                                                              | Synthetic projects; no real user coding task executed.                                                                                                                                  |
| Native interfaces     | Two pinned Gateway contracts verify the locked core, hello features, config schema and lookup, `replacePaths`, stale hashes, pairing list and a denied exec approval.                                                                                                                                                                                                                                                                   | Deterministic HTTP model; no WhatsApp login, pairing approval or allowed exec.                                                                                                          |
| Web tools and browser | The compiled team-mode startup configuration (team plugin, memory, DuckDuckGo plugin from the runtime descriptor, isolated browser) is accepted; `web_fetch` refuses loopback, the browser uses only `openclaw` profiles in the data dir, temporary members get no capability tool; each bundled search plugin loads.                                                                                                                   | Deterministic model, no real search; `pdf` granted but not offered on custom providers; Linux Chrome sandbox CI-only, unverified locally.                                               |
| MCP servers           | Hand-patched and AgentPier-compiled Streamable HTTP and stdio servers reach only bound agents (global `bundle-mcp`, agent `<name>__*`) in team mode; bindings, header rotation and removals hot-apply through `McpChanges` without a restart; a lead passes a server to an approved temporary member, which loses it when it ends; header and env values stay redacted and out of logs.                                                 | Local test servers and deterministic model; SSE and idle eviction unqualified; automatically approved teams covered against a fake Gateway only.                                        |
| MCP OAuth             | OpenClaw's CLI login (printed URL with the redirect port held, `--code`, status shapes, refresh, revocation, logout, orphaned logins) and AgentPier's compiled path: store, compile, `McpOAuthLogins`, the login/logout routes and the callback with `state` check; the agent's next turn uses `<name>__<tool>` after the post-login backoff reset; logout, logout-first rename and a deferred logout drained at the next start.        | Local mock authorization server with dynamic client registration, Streamable HTTP only; no real provider; SSE with OAuth and a real HTTPS (Tailscale) callback unexercised.             |
| Agent shell access    | Hand-patched and AgentPier-compiled exec levels in team mode: allow-once, OpenClaw's allow-always, AgentPier's program entries for owner-writable programs (any arguments), interpreters allowed once only, deny, full, off, live level changes without a restart, allowlist deletes, permanent versus temporary members, a restart cancelling a pending approval; children see the owner's `HOME` and `PATH`, never the Gateway token. | Simulated owner account and deterministic model; Telegram approvals against a fake Gateway; `process`, a real 30-minute expiry and Linux allow-always availability unqualified locally. |
| Provider endpoints    | Explicit opt-in runner for Ollama, llama.cpp and Azure-compatible endpoints.                                                                                                                                                                                                                                                                                                                                                            | Ollama and llama.cpp passed with small local models (2026-10-10); Azure remains unqualified.                                                                                            |

The detailed records are [memory](assistant-memory-qualification.md),
[schedules](assistant-routine-qualification.md),
[native interfaces](assistant-native-interface-qualification.md),
[web tools](assistant-web-tools-qualification.md),
[MCP servers](assistant-mcp-qualification.md),
[MCP OAuth](mcp-oauth-qualification.md),
[shell access](assistant-shell-qualification.md), and
[providers](assistant-provider-qualification.md). Native memory and update tests
exercise actual Gateway processes with a deterministic HTTP model. Provider
protocol tests against simulated endpoints are not actual vendor qualification.

## Recorded end-to-end runs (2026-10-19, AGENTPIER-173)

Two opt-in native contracts run whole owner journeys on the pinned runtime instead
of one subsystem at a time. Both build the production assistant graph
(`constructAssistantGraph` and `connectAssistantServices` from
`server/application/assistant-graph.js`, as AgentPier wires it) in a disposable data
directory, mount AgentPier's own assistant routes (`assistantRoutes`) on a loopback server and
drive the owner's steps through them (`tests/helpers/assistant-e2e-graph.js`). They
need `AGENTPIER_E2E_CONTRACT_RUNTIME`, which
`scripts/provision-assistant-contracts.mjs` exports with the other contract
variables, skip without it and run in the `native-contracts` CI job.

What is real and what is a double:

| Part               | In the run                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway            | The pinned OpenClaw 2026.10.3 runtime (Node 26.12.1, lock `5d0ace4d722a…`) with the installed team plugin, started by AgentPier's `RuntimeSupervisor`; only its runtime selection points at the provisioned installation. |
| AgentPier services | All production services and their wiring: `AssistantService`, `TeamService` with its scheduler and lead requests, `TeamBridge`, `NativeReminders`, `ChannelService`, `AssistantWorkflows`, `LeadShares`, `McpTools`.      |
| Model              | A scripted OpenAI-compatible loopback endpoint behind a real endpoint provider connection (`ProviderConnections`, preset `custom`); it decides each turn from its text and tool results.                                  |
| Telegram           | The loopback Bot API of the agents' own bots contract (`tests/helpers/assistant-telegram-fakes.js`), reached through `TelegramClient`'s `apiRoot` test seam.                                                              |
| Transcription      | AgentPier's `SpeechService` and `DeepgramTranscriber`; only the request to `api.deepgram.com` is redirected to a loopback `/v1/listen` fake with a fixture key.                                                           |
| Coding run         | AgentPier's real `PipelineEngine` with a one-stage pipeline; its stage driver launches no coding CLI and no tmux session but writes a passing verdict and an artifact into the run's workspace.                           |
| Timing             | No clock hooks: the reminder is due 15 seconds after the agent creates it and fires through OpenClaw's own scheduler.                                                                                                     |

**Voice note to reminder** (`tests/integration/assistant-voice-reminder-e2e-contract.test.js`).
The owner creates an agent with reminders, saves the speech key, connects and pairs
the owner's AgentPier bot (`/start <code>` through the fake Bot API) and sends a
voice note. Observed sequence: Deepgram request with `Token <key>` and the chosen
language → the transcript reaches the agent's turn with `agentpier_reminder` offered
→ the agent creates a one-shot reminder (Telegram delivery on, because it was asked
from Telegram) → its confirmation goes back to the Telegram chat → at its time the
reminder runs as its own native turn without tools → the text reaches the Telegram
chat, the agent's main chat (marked `scheduled: { kind: "reminder" }`) and an
`agent-routine` push notice for that chat.

**Lead, member, coding run** (`tests/integration/assistant-team-coding-e2e-contract.test.js`).
The owner creates a lead and grants it a project and the pipeline
(`PUT /api/assistants/:id/access`). The lead proposes a team, the owner approves it
with `lifetime: "permanent"`, the member reports and the lead's synthesis completes
the team. The owner then asks for a coding task. Observed sequence: the lead calls
`agentpier_team_delegate` with `access: { coding: [project] }` (a task share, shown
as `member-grant` in both chats) → the member's turn calls
`agentpier_workspace` `coding_start` → the request waits for the owner on the
member with `inherited.leadId` and is listed in the lead's actions → nothing runs
before `POST /api/assistant-actions/:id/decision` approves it → the engine runs and
completes the pipeline on the lead's project (two `coding-run` notes in the member's
chat) → the member reads `coding_status` and reports → the task completes and a
`member-result` turn in the lead's chat produces the lead's summary. A second task
ends right after its coding request; the lead reports that the run waits, and the
owner's later approval still starts and completes the run on the ended task's share.

Runs on macOS 26.5.1 arm64 (Node 22.22.2 for the tests) on 2026-10-19, each contract
alone with
`node --test --test-concurrency=1 tests/integration/assistant-<name>-e2e-contract.test.js`
after `node scripts/provision-assistant-contracts.mjs --data-dir <tmp> --env-file <file>`:

| Contract       | Run 1 | Run 2 | Run 3 | Outcome  |
| -------------- | ----- | ----- | ----- | -------- |
| Voice reminder | 69 s  | 43 s  | 40 s  | 3/3 pass |
| Team coding    | 53 s  | 51 s  | 40 s  | 3/3 pass |

The Gateway start takes 11–28 s of each run (other suites ran on the host); the
reminder arrives 17–23 s after its creation, the coding run ends about 2 s after the
approval, and the member's result reaches the lead 3–5 s after the run. Both are
deterministic and well below three minutes, so the `native-contracts` job runs them.

**Bug found and fixed.** The team scheduler prunes ended lead shares on every tick
(`TeamMcpBindings.refresh` → `LeadShares.prune`), so a task's share was deleted about
a second after its task ended. A coding request resting on it was then refused at
the owner's approval (`403 invalid`), although `LeadShares.authorize` is meant to
accept a share that ended only with its task. Any member that ended its task before
the owner decided hit this. The prune now keeps such
a project share while a coding request on it waits for the owner or runs
(`LeadShares.restsOn`); the second task above and a regression case in
`tests/integration/assistant-lead-shares.test.js` cover it.

**Boundaries.** No real model, Telegram, Deepgram or coding CLI is involved; the
coding stage is simulated after the engine starts it. The voice path is the owner's
AgentPier bot (`server/features/assistant-channels/`): reminders need an AgentPier
turn, and the agents' own bots for other people cannot create them
(`team-bridge.js` refuses their turns). Linux results come from the CI job.

## Adjacent runtime update and rollback

The previous runtime was installed in a separate disposable installation from the
official npm package `openclaw@2026.9.7`, using its published SHA-512 integrity:

```text
/8N2LnfTFQPvnZizi8qKSFfnLQaPvSG3Cb4xo1YV7b4JhYiUc43ZNRpXJ01bWghLK0Ezk3HVeo/DGHcIRQwRWA==
```

The candidate remains the manifest-pinned `2026.9.8`, using Node `26.7.0`.
Each case creates its own assistant, native memory, conversation, completed request
receipt and disabled recurring schedule. Successful activation retains all of
these through a subsequent Gateway restart without issuing another model request.
The failure case modifies native memory during candidate validation and throws;
rollback restores both the previous runtime and original memory. Conversation,
schedule and receipt survive restart without replay. This test does not send
Telegram messages or assert behavior for every upstream data/schema migration.

Qualification exposed two installer defects: the team plugin accepted only the
current version, and selecting an existing runtime bypassed bundled-plugin repair.
The plugin now explicitly accepts the qualified predecessor as well as the current
pin; unqualified versions remain rejected. Selection repairs missing plugin files.
Unit regressions passed after reproducing both failures, and the native team bridge
contract passed against the predecessor (two cases).

### OpenClaw 2026.9.8 → 2026.9.9 (2026-10-14)

The security update to 2026.9.9 (MCP SDK 1.31.0, Dependabot alert #23) was qualified
on macOS arm64 against the lock `c197993dfd41…`. Both runtimes were provisioned with
`scripts/provision-assistant-contracts.mjs`: 2026.9.8 from `origin/main`, 2026.9.9 from
the update branch.

- Both cross-version cases above passed 2026.9.8 → 2026.9.9. The MCP OAuth upgrade
  case (`assistant-mcp-oauth-cross-version.test.js`) logs in on 2026.9.8, activates
  2026.9.9 through `RuntimeUpdates`, and refreshes the login twice there: no new client
  registration or authorization, `mcp status --json` stays plain JSON, and the SDK's
  missing-`issuer` warning appears once in the Gateway log (the first refresh stamps
  the tokens). It also passed 2026.9.8 → 2026.9.8 before the bump.
- The team plugin, native write and runtime contracts passed on 2026.9.8, which stays
  a rollback target and keeps the write guard. 2026.9.7 remains a rollback target from
  its earlier qualification; the team plugin is unchanged.
- The application's own services staged 2026.9.9 next to a 2026.9.8 installation that
  `origin/main` provisioned (installer rerun: `staged`), activated it with a snapshot,
  kept the session across a restart and then removed the 2026.9.8 installation.
- `scripts/verify-assistant-installation.mjs` passed. All 28 native contract files of
  the `native-contracts` job passed: 57 tests, 0 skipped.
- Both versions use state database schema 19 and agent database schema 24, so
  2026.9.9 runs no schema migration that 2026.9.8 would refuse. This is read from the
  packages, not exercised: a committed update is not rolled back by AgentPier.

### OpenClaw 2026.9.9 → 2026.10.3 (2026-10-14)

The update to 2026.10.3 was qualified on macOS arm64 against the lock
`5d0ace4d722a…`. It is the first update in this record that migrates OpenClaw's
state database, so it cannot be undone once committed.

**Pins.** `openclaw` 2026.10.3 and the search plugins
`@openclaw/{duckduckgo,perplexity,brave}-plugin` 2026.10.3 (peer dependency
`openclaw >=2026.10.3`), Node 26.7.0 (2026.10.3 requires
`>=24.16.0 <25 || >=26.1.0`, as before). The lock was resolved in full with
`scripts/refresh-assistant-runtime-lock.mjs`; a second run reproduced it byte for
byte. `rollbackTargets` is now `["2026.9.9", "2026.9.8"]`: 2026.9.7 is dropped
because the team plugin no longer accepts it. `writeGuardRuntimes` adds 2026.10.3
after the native write and team plugin contracts passed on it.

**Lock changes.** Against the 2026.9.9 lock, `chokidar` and `readdirp` are gone and
19 entries change version: OpenClaw itself, `@openclaw/ai` and the three plugins;
`@openclaw/fs-safe` 0.21.1 → 0.24.2 with its seven platform packages; npm
11.20.0 → 12.1.0; `openai` 7.20 → 7.23; `@anthropic-ai/sdk` 0.127 → 0.128;
`@google/genai` 2.23 → 2.24; `@agentclientprotocol/sdk` 1.4 → 1.5; and `dotenv`
18.0.1 → 18.0.3.

**Correction: bundled packages are not in the lock.** The 2026.9.8 → 2026.9.9
lock refresh removed 146 entries. All of them were bundled packages
(`inBundle`): 143 from npm's own bundle and three that OpenClaw bundles
(`@openclaw/proxyline`, `chrome-devtools-mcp`, `undici`).
`npm install --package-lock-only` does not record the children of bundled
dependencies, and the 2026.10.3 lock leaves them out the same way. Their
integrity is still covered by the SHA-512 of the archive that contains them, but
Dependabot cannot see them, so their advisories need a manual review of the
containing package.

**Database migration.** 2026.10.3 raises the state database schema from 19 to 20;
the migration adds `cron_run_receipts.delivery_attempt_state`
(`TEXT NOT NULL DEFAULT 'unknown'`). The agent database stays at schema 24. The
versions were read from the `createNewerSqliteSchemaVersionError` literals in both
packages and confirmed by a live probe: 2026.9.9 and 2026.9.8 refuse a schema-20
database. A rollback before the update is committed restores the snapshot taken
before activation; after commit there is no downgrade.

**Adaptations.**

- **Agent roster.** 2026.10.3 refuses an `agents.list` array and boolean `default`
  markers on agent entries with exit code 78 (`INVALID_CONFIG`); 2026.9.x only
  warned. A fresh configuration now writes `agents.entries: { main: {} }`, and
  `canonicalAgentRoster()` in `runtime-config.js` converts a legacy list at every
  compile: a roster of two or more agents gets `agents.ownership: "explicit"` with
  `agents.defaults.systemAgent` and `talk` on the former default agent. 2026.9.8,
  2026.9.9 and 2026.10.3 accept the result.
- **CLI failure reasons.** 2026.10.3 prints the `[openclaw] Reason:` line of a
  failed CLI command only with `OPENCLAW_DEBUG`. `openclaw-mcp-cli.js` sets
  `OPENCLAW_DEBUG=1`, which OpenClaw reads only when it formats a failure; the
  stack trace it adds on stderr is ignored (see
  [MCP OAuth qualification](mcp-oauth-qualification.md#openclaw-2026103)).
- **Scheduler scope.** OpenClaw's `CronService` now requires `scheduler.scope()`;
  only the schedule qualification test helper needed it.
- **Session creation.** `sessions.create` can answer `UNAVAILABLE` (retryable) after
  waiting about 20 seconds for the model catalog. `createGatewaySession` in
  `server/features/assistants/session-create.js` retries an answered `UNAVAILABLE`
  that is `retryable` or carries the remote error class
  `SessionMutationFactsUnavailableError` (see below), pausing 500, 1000 and
  2000 ms within the 60-second budget. A team member whose creation still fails
  this way returns to `queued` instead of `provisioning_uncertain`.
  `assistant-session-create.test.js` and `assistant-team-recovery.test.js` cover
  the retry.
- **Session storage refusal.** `sessions.create` can also answer `UNAVAILABLE`
  without `retryable`, from `SessionMutationFactsUnavailableError` ("Session
  access facts are unavailable; retry after session storage is ready."). OpenClaw
  2026.9.9 has the same refusal. It comes before the session entry commits. A retry cannot
  create a second session with the same label. `session-create.js` therefore
  retries it like the catalog answer. `assistant-session-create.test.js` and
  `assistant-team-recovery.test.js` cover the retry. The skills contract hit it
  three times during qualification; about 125 further creates on 2026.10.3 and 38
  on 2026.9.9 did not reproduce it.

**New native tool.** 2026.10.3 grants `skills_read` to every agent whose allow list
contains `read`, which covers all agents with memory and routine runs. It is
read-only and returns only installed skills that are eligible for the agent; the
owner accepted it (see [Skills](assistant-gateway.md#skills)).

**Not applicable.** Sealed immutable install generations (opt-in), the migration of
agents to local Claws (manual), the provider-native compaction default (API-key
routes only) and the webhook listener migration do not affect AgentPier.

**Results.**

- All 31 files of the `native-contracts` job passed on 2026.10.3: 65 tests, 0
  failures, 0 skipped. The same run on 2026.9.9 gave the identical result, so the
  "28 native contract files … 57 tests" in the 2026.9.9 section above is outdated:
  the job has since grown to 31 files.
- `npm run check` had one failure, the known environment-dependent Unicode
  login-shell test in `tests/integration/shell.test.js`.
- `assistant-runtime-cross-version.test.js` 2026.9.9 → 2026.10.3: 3 of 3 cases
  passed (activation, rollback after failed validation, and the legacy agent
  roster). A live check confirmed the database boundary: after a rollback the state
  database stays at `user_version` 19 and 2026.9.9 starts; after commit it is at 20
  and 2026.9.9 refuses to start, first on `meta.lastTouchedVersion`, then on
  schema 20.
- `assistant-mcp-oauth-cross-version.test.js` 2026.9.9 → 2026.10.3 passed, with no
  SDK missing-issuer warning after the update.
- `scripts/verify-assistant-installation.mjs` passed on 2026.10.3.
- The team plugin, native write and runtime contracts passed with the new code on
  the rollback targets 2026.9.9 and 2026.9.8 (4 of 4 on each).
- The write-guard contract passed on 2026.10.3.
- Browser: the Chromium desktop `assistant*.spec.js` files gave 347 passed and 5
  skipped (screenshot-only). One timing flake (`assistant-chat.spec.js:224`, iPad
  keyboard) passed 3 of 3 runs on its own.

Repeat the cross-version tests with immutable executable installations only:

```sh
AGENTPIER_ASSISTANT_PREVIOUS_RUNTIME=/absolute/path/to/2026.9.9-runtime \
AGENTPIER_ASSISTANT_UPDATE_RUNTIME=/absolute/path/to/2026.10.3-runtime \
  node --test tests/integration/assistant-runtime-cross-version.test.js \
  tests/integration/assistant-mcp-oauth-cross-version.test.js
```

See [runtime update operations](assistant-runtime-updates.md) for the maintenance,
backup, admission and recovery boundaries. The installer verifies the top-level
OpenClaw archive and Node checksums. The subsequent locked-installer work also pins
the transitive dependency graph; see [installation qualification](assistant-runtime-updates.md#fresh-native-qualification)
for its fresh native platform matrix and remaining boundaries.

### Update paths installed users take

An installed AgentPier updates to the newest release, and its next start stages the
runtime that release pins (`stageRuntimeInBackground`); the owner activates it. No
release requires an intermediate step, so a user's runtime update goes from whatever
runtime their last release pinned straight to the current pin. The release tags pin:

| AgentPier release | Pinned OpenClaw (Node) | Rollback targets   | Update path to the current pin (2026.10.3, Node 26.12.1) |
| ----------------- | ---------------------- | ------------------ | -------------------------------------------------------- |
| v1.27.0 – v1.28.1 | 2026.9.8 (26.7.0)      | 2026.9.7           | 2026.9.8 → 2026.10.3 (skip update)                       |
| v2.0.0            | 2026.9.9 (26.7.0)      | 2026.9.8, 2026.9.7 | 2026.9.9 → 2026.10.3                                     |
| v2.1.0 – v2.5.1   | 2026.10.3 (26.7.0)     | 2026.9.9, 2026.9.8 | Node 26.7.0 → 26.12.1, same OpenClaw and lock            |

Releases before v1.27.0 had no managed assistants. 2026.9.7 was never pinned by a
release, so no installed user runs it. 2026.9.8 → 2026.9.9 is no longer reachable:
a v1.28.x user now updates to a release that pins 2026.10.3.

### OpenClaw 2026.9.8 → 2026.10.3 skip update (2026-10-19)

Qualified on macOS arm64 (Darwin 25.5) at `26cef2a6`, in disposable data directories.
Each predecessor runtime was installed by its own release's code, manifest and lock:
`git archive v1.28.1` and `git archive v2.0.0` into a scratch directory, then
`node scripts/provision-assistant-contracts.mjs --data-dir <dir> --env-file <file>`
there, which gave `2026.9.8-node26.7.0-darwin-arm64-lock93bd048153fd` and
`2026.9.9-node26.7.0-darwin-arm64-lockc197993dfd41`. The pin then, until the move to
Node 26.12.1, was `2026.10.3-node26.7.0-darwin-arm64-lock5d0ace4d722a`; the current
pin is `2026.10.3-node26.12.1-darwin-arm64-lock5d0ace4d722a`. Older release trees need no
`npm ci` for provisioning.

- `assistant-runtime-cross-version.test.js` and
  `assistant-mcp-oauth-cross-version.test.js` with 2026.9.8 as the previous and
  2026.10.3 as the update runtime: 4 of 4 passed, 0 skipped (152 s). Activation keeps
  memory, the disabled schedule, history and the completed receipt across a restart
  without a model request; an injected validation failure rolls back to 2026.9.8 with
  the original memory; a legacy `agents.list` roster is canonicalized; the MCP OAuth
  login made on 2026.9.8 refreshes twice on 2026.10.3 without a new registration or
  authorization. The SDK's missing-`issuer` warning appears once after the update, as
  in the 2026.9.8 → 2026.9.9 record: 2026.9.8 does not stamp the issuer.
- **Application path.** A throwaway `node:test` file (not committed) used
  `applicationFixture` (`tests/helpers/application.js`): its data directory was
  first provisioned by the v1.28.1 tree, then the current code started on it. The
  background staging prepared 2026.10.3 (`candidateReady: true`, current 2026.9.8),
  `POST /api/assistant-runtime/updates/activate` answered 200 with phase
  `complete` and a snapshot under `assistants/backups/`, retention removed the
  2026.9.8 installation, and after an application restart the status stayed at
  2026.10.3 with `updateAvailable: false`. The same run from a v2.0.0 installation
  (2026.9.9 → 2026.10.3) passed identically.
- **Rollback.** Before commit, a failed activation restores 2026.9.8 (case above).
  After commit there is no downgrade: 2026.10.3 migrates the state database to
  schema 20, which 2026.9.8 refuses like 2026.9.9 (see the 2026.10.3 section), and
  retention deletes the 2026.9.8 installation. The team plugin still accepts 2026.9.8
  because it stays in `rollbackTargets`.

Repeat it with the commands above and:

```sh
AGENTPIER_ASSISTANT_PREVIOUS_RUNTIME=/absolute/path/to/2026.9.8-runtime \
AGENTPIER_ASSISTANT_UPDATE_RUNTIME=/absolute/path/to/2026.10.3-runtime \
  node --test --test-concurrency=1 tests/integration/assistant-runtime-cross-version.test.js \
  tests/integration/assistant-mcp-oauth-cross-version.test.js
```

The `cross-version` job of the `Assistant runtime` workflow now repeats both
pairs on Ubuntu x64 nightly, on demand and before a release. It checks out the
release tags `v1.28.1` and `v2.0.0`, provisions their runtimes as above, and fails
when a test skips. Its matrix must follow `rollbackTargets`: a predecessor that
leaves the list is refused by the team plugin and leaves the matrix too.

### Node 26.12.1 security update (2026-10-23)

The managed runtime moves from Node 26.7.0 to 26.12.1, the patched 26.x line of the
[Node.js October 2026 security releases](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
OpenClaw stays at 2026.10.3, the lock stays `5d0ace4d722a…` and `rollbackTargets`
stays `["2026.9.9", "2026.9.8"]`; the team plugin checks OpenClaw versions only.
Node 26.12.1 bundles npm 11.20.0 (was 11.19.0), so `npmVersion` follows it. The four
`nodeChecksums` come from `https://nodejs.org/dist/v26.12.1/SHASUMS256.txt`, whose
signature was verified against release key `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`.
The MCP Node toolchain derives from the same pins and becomes `node-v26.12.1-<target>`.

The lock was not re-resolved: a Node security release changes no package, and a full
refresh would move transitive versions without a reason. `refresh-assistant-runtime-lock.mjs --keep-graph`
on the new runtime reproduced both lock files byte for byte with npm 11.20.0.

Installed users on v2.1.0 – v2.5.1 run `2026.10.3-node26.7.0-<target>-lock5d0ace4d722a`.
The changed Node version is part of the runtime identity, so their next start stages
`2026.10.3-node26.12.1-<target>-lock5d0ace4d722a` next to it, and activation goes
through the usual snapshot, validation and rollback flow. OpenClaw's state schema is
unchanged, so this update runs no migration.

Qualified on macOS arm64 (Darwin 25.5) in disposable data directories:

- All 40 native contract files of the `native-contracts` job against the new runtime:
  85 of 85 passed, 0 skipped (about 32 minutes).
- `scripts/verify-assistant-installation.mjs` and `scripts/verify-mcp-toolchains.mjs darwin-arm64`
  passed (`node v26.12.1, npm 11.20.0`).
- **Node-only update path.** The predecessor runtime came from a `git archive v2.5.1`
  tree via its own `provision-assistant-contracts.mjs`. A throwaway copy of
  `assistant-runtime-cross-version.test.js` (not committed) that tells the runtimes
  apart by Node path instead of OpenClaw version passed 3 of 3: activation keeps
  memory, the disabled schedule, history and the receipt across a restart without a
  model request; an injected validation failure restores the Node 26.7.0 runtime and
  the original memory; the legacy roster is canonicalized. The committed
  `cross-version` job cannot run this pair because it requires two OpenClaw versions.

### Native architectures (2026-10-19)

The runtime manifest pins Node checksums for darwin-arm64, darwin-x64, linux-arm64
and linux-x64 (glibc); the transitive lock carries the native packages for all four
(`@openclaw/fs-safe`, `sqlite-vec`, `@lydell/node-pty` and others; musl and
Windows packages are present but unused, because there is no Node pin for them). Any
other host gets `Unsupported assistant runtime platform`.

| Target       | Fresh install (`fresh-install`)           | Native contracts (`native-contracts`)              |
| ------------ | ----------------------------------------- | -------------------------------------------------- |
| linux-x64    | `ubuntu-24.04`, also pull requests        | `ubuntu-latest`, also pull requests                |
| linux-arm64  | `ubuntu-24.04-arm`, also pull requests    | `ubuntu-24.04-arm`, nightly and release only (new) |
| darwin-arm64 | `macos-15`, after merge and nightly       | `macos-latest`, after merge and nightly            |
| darwin-x64   | `macos-15-intel`, after merge and nightly | not run                                            |

Intel Macs (darwin-x64) stay supported: release packages are built for them and the
fresh install and MCP toolchain jobs run on `macos-15-intel`. The full native agent
contract qualification does not run there, because the hosted Intel runners are slow
and produced repeated timing flakes. Agents on Intel Macs are therefore not covered
by the full native qualification; linux-x64, linux-arm64 and darwin-arm64 are. On Linux arm64 the web tools contract uses Google
Chrome when the image has it and otherwise Playwright's Chromium, for which the job
lifts the Ubuntu 24.04 AppArmor restriction on unprivileged user namespaces (on the
disposable runner only) so Chromium's sandbox starts. These jobs were validated with
`actionlint` 1.7.12 only; neither runner can be exercised locally, so their first
nightly (or a manual `workflow_dispatch` of `Assistant runtime`) is the first
evidence. Like every advisory job, a red result blocks the next release through
`full.yml` until it is fixed.

## Main integration

Project identity changes from main must not transfer assistant authorization to a
new project ID. The new regression cases confirm that old grants stop working,
automatic rebind does not confer access, stale approvals cannot be revived by a
later explicit grant, and duplicate merging cannot expose replacement-project
knowledge or permit coding starts. Existing sessions/artifacts are represented by
empty adapters in these focused coordinator tests.

## Independent review corrections

Pausing a reminder now persists delivery revocation before the native update RPC.
Late completions and queued output stay blocked across lost acknowledgements,
adapter recreation and capability disable/re-enable. Only a confirmed explicit
resume restores delivery; a native one-shot completing normally can still deliver.
Three regressions reproduced the old behavior before the fix, and the native
routine/webhook and scheduler contracts passed afterward.

Forwarded Telegram messages remain quoted data: workspace, reminder and routine
tools reject forwarded-turn authority before reading or mutating managed state.
Regression cases cover autonomous coding starts, project-memory proposals and
schedule operations, with ordinary direct Telegram requests as positive controls.

Native account logout now uses the shared admission/scheduler maintenance boundary.
Dependent schedules pause before OpenClaw removes the account; offline preparation
restores each exact selected profile with an empty fallback list. Non-secret profile
identities remain private after logout so process restart cannot silently substitute
another account. A lost logout acknowledgement keeps maintenance active for recovery.
The native regression uses two synthetic OAuth profiles and never sends inference
requests or imports personal credentials.

The first PR CodeQL run flagged request-derived provider secret paths and a public
transport identifier derived from a hash containing credential material. Secret
paths now use only validated stored/generated record IDs; existing validation
already rejected traversal, and adversarial service/HTTP regressions cover that
boundary. Transport identifiers are now random, stable within a process for the
same configuration, and changed on credential/configuration changes. They no longer
expose reproducible credential-derived hashes. A failing identity regression was
reproduced before the fix; independent focused review and the nine-case native
provider/scheduled-credential suite passed afterward. Static resolution is tracked
by the pull request's CodeQL check.

## Final local validation

On the reviewed tree, `npm run check` passed: 4,392 tests passed, 30 conditional
skips, zero failures (4,422 total). This includes lint, formatting, structure checks
and the application build. Agent UI suites passed 34 cases in Chromium and 34 in
WebKit, including English desktop/mobile views and German diagnostics.

The final combined opt-in native run passed 16 tests with no skips, plus nine
native scheduler child cases. It covers central endpoint protocol/tool streaming,
credential rotation/revocation for scheduled work, synthetic account logout,
routines/webhook delivery, same-version activation, adjacent-version activation
and rollback, and scheduler qualification. The unchanged memory contract passed
two cases, and the predecessor plugin contract passed two cases separately.
Independent review reproduced all three authorization/delivery findings, verified
the fixes, and reported no remaining Critical/Important blockers.

These are local results; GitHub CI status is reported on the pull request. The UI
screenshots use synthetic fixtures: [team chat](screenshots/assistant-teams-desktop.png)
and [mobile settings](screenshots/assistant-workflows-mobile.png).

## Release checklist: MCP OAuth (2026-10-11)

A release that changes the MCP server store, `McpOAuthLogins`, the OpenClaw CLI
wrapper, the OAuth routes or the pinned OpenClaw version must pass, with no skips:

- `tests/integration/assistant-mcp-oauth-contract.test.js` (OpenClaw's CLI and
  status facts) and `tests/integration/assistant-mcp-oauth-compiled-contract.test.js`
  (AgentPier's compiled path), both in the `native-contracts` CI job on Ubuntu and
  macOS;
- the MCP contracts (`assistant-mcp-contract.test.js`,
  `assistant-mcp-compiled-contract.test.js`), which share the compile and the live
  patches;
- `tests/integration/mcp-oauth-backups.test.js` (logins out of host backups, sealed
  in update snapshots) and the `mcp-oauth*` unit and blackbox suites in
  `npm run check`.

A new OpenClaw version is requalified against the facts in the
[MCP OAuth qualification](mcp-oauth-qualification.md), in particular the printed
login output, the `status --json` shape and the startup backoff that the post-login
`mcp` change lifts.

## Remaining scope

Actual Azure inference/tool behavior (Ollama and llama.cpp passed on 2026-10-10), real
Linux hosts and production deployment remain separate gates. Runtime version pairs and
the native architectures are covered as described under
[update paths installed users take](#update-paths-installed-users-take) and
[native architectures](#native-architectures-2026-10-19). Gmail, M365, Google Calendar, Apple services and sandbox design remain
explicitly deferred. The owner can test a deployment after review; this
qualification does not change the existing personal trial.

## Locked installer follow-up

The reviewed transitive lock is now shipped with the runtime manifest. Local
`npm run check` passed with 4,405 passing tests and 30 conditional skips (4,435
total), including lint, formatting, structure and build. Fresh native installation
on macOS ARM64 verifies exact Node/npm/OpenClaw, authenticated Gateway access,
cached installation reuse and retained history after restart. Independent review
found no important issues. The four-target runtime installation workflow records the other host results. At
the time, full Chromium and WebKit CI failures at `21935d4f` still required diagnosis;
the next section records their resolution.

## Browser fixtures and subsequent main integration

The branch incorporates main through `779cbb0c`. Full browser CI failures were
traced to existing fixtures missing the new global assistant reads, empty model
account responses crashing the fixture-backed account page, and a sidebar locator
matching both coding-session and agent-chat lists. A shared exact-GET helper now
serves dormant assistant state; unknown reads and writes retain the original
fixture behavior. The sidebar assertion targets the coding-session group.

After reproducing the failures, 116 representative cases passed in Chromium and
116 in WebKit, covering accounts, navigation, installation, sidebar, chat, memory,
file navigation, operations and pipelines. The complete CI matrix must pass on
the updated PR before merge.

Main's new per-CLI routing also exposed an integration regression: assistant
endpoint validation used OpenCode eligibility and incorrectly hid native Chat
Completions models when OpenCode was disabled or selected an unavailable protocol.
Assistant eligibility now reads the validated model catalog independently of CLI
routing, retaining protocol/authentication checks and native context limits. Both
new regression cases failed before the fix and passed afterward. Independent
review found no important issues in the fixture changes or the routing correction.
