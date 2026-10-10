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
  from the owner), additional runtime version pairs, other architectures, production
  deployment, team spend budgets (AGENTPIER-7), and Gmail, Microsoft 365, Google
  Calendar, Apple services and a sandbox.

## Deeper checks

| Area               | Evidence                                                                                                                                                                   | Boundaries                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Native memory      | Two pinned Gateway contracts verify deletion/re-index/restart, model-reference switching and agent isolation.                                                              | Deterministic HTTP model; no semantic embeddings or erasure of historical transcripts/backups.  |
| Native scheduling  | Nine native scheduler cases cover Berlin/New York DST, explicit timezones, 30-day downtime, restart, missed-run policy, backlog spacing and duplicate completion delivery. | Injected clock with real scheduler/SQLite; not an operating-system suspend or crash experiment. |
| Runtime update     | Two native cases verify OpenClaw 2026.9.7 → 2026.9.8 activation and rollback after injected candidate validation failure.                                                  | Node 26.7.0, macOS arm64, exact adjacent pair only.                                             |
| Project identity   | Three real Git/ProjectMemory/ProjectRebind cases cover git initialization, automatic rebind and duplicate-project merging.                                                 | Synthetic projects; no real user coding task executed.                                          |
| Provider endpoints | Explicit opt-in runner for Ollama, llama.cpp and Azure-compatible endpoints.                                                                                               | Ollama and llama.cpp passed with small local models (2026-10-10); Azure remains unqualified.    |

The detailed records are [memory](assistant-memory-qualification.md),
[schedules](assistant-routine-qualification.md), and
[providers](assistant-provider-qualification.md). Native memory and update tests
exercise actual Gateway processes with a deterministic HTTP model. Provider
protocol tests against simulated endpoints are not actual vendor qualification.

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

Repeat the cross-version test with immutable executable installations only:

```sh
AGENTPIER_ASSISTANT_PREVIOUS_RUNTIME=/absolute/path/to/2026.9.7-runtime \
AGENTPIER_ASSISTANT_UPDATE_RUNTIME=/absolute/path/to/2026.9.8-runtime \
  node --test tests/integration/assistant-runtime-cross-version.test.js
```

See [runtime update operations](assistant-runtime-updates.md) for the maintenance,
backup, admission and recovery boundaries. The installer verifies the top-level
OpenClaw archive and Node checksums. The subsequent locked-installer work also pins
the transitive dependency graph; see [installation qualification](assistant-runtime-updates.md#fresh-native-qualification)
for its fresh native platform matrix and remaining boundaries.

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

## Remaining scope

Actual Azure inference/tool behavior (Ollama and llama.cpp passed on 2026-10-10), additional runtime
version pairs, Linux/other architectures and production deployment remain separate
gates. Gmail, M365, Google Calendar, Apple services and sandbox design remain
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
