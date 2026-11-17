# Session Limit Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native Claude/Codex session that hits a usage or rate limit shows as "Limit reached" in the session list and chat, its limit reply is marked as a notice, and the chat offers "Change model" and "Continue".

**Architecture:** The CLI's limit report (Claude `StopFailure` hook, Codex `turn/completed` with a usage-limit code) is persisted as `limit: { detail }` on the existing native activity file; any later activity write drops it. `readNativeActivity` → `mergeActivity` → `SessionActivity` carry it to the `state` live topic, so the web reads `session.activity.limit`. Transcript parsers tag limit replies with `notice: "usage-limit"`. The web shows a limit bar above the composer with two actions that reuse the model picker and the normal send path.

**Tech Stack:** Node.js ES modules, `node:test`, React (JSX), existing i18n catalogs.

**Spec:** `docs/superpowers/specs/2026-11-17-session-limit-notice-design.md`

## Global Constraints

- Source and test files ≤ 600 lines (`check:structure`). `server/features/chat/history-parsers.js` is at 596: put new parsing logic in a new module and keep that file ≤ 600 after Prettier.
- No new hex colours, no font size < 11px, no bespoke dialogs; reuse `.chat-limit-warnings` styling and `Button`-style existing classes (see `docs/ui-guide.md`).
- Every new UI string in `web/lib/i18n/de/` and `web/lib/i18n/en/` with matching keys; server label in `server/lib/i18n/de/` and `en/`; run `npm run i18n:confirm` and commit the `translation-lock.json` files.
- Limit detail text is the CLI's own message, ≤ 500 chars, never parsed into a date.
- No automatic model switch; no session restart.
- Commits in English with `feat:`/`fix:` prefixes.

## Review Focus

1. A turn that starts after the limit (owner's next prompt, or `/model` + prompt) must clear the limit state at once (`UserPromptSubmit` / `turn/started` writes a value without `limit`) — test in Task 1.
2. An out-of-order older hook write must not resurrect or drop the limit (existing `newer()` check keeps the latest event) — covered by existing ordering; Task 1 asserts a later `Stop` clears it.
3. The Claude bridge mod's live status (`liveActivity`) reports `idle` → "Ready" and must not hide "Limit reached" — test in Task 3.
4. A limit reply in history that is not the latest state (an old limit from days ago, session since continued) shows only as a styled notice, never with action buttons — the bar depends on `session.activity.limit`, not on transcript messages (Task 4 test).
5. Activity files written by an older release (no `limit` field) and malformed `limit` values read as "no limit" — test in Task 1.

---

### Task 1: Persist the limit on native activity

**Files:**
- Modify: `server/features/sessions/native-session-activity.js` (`claudeHookActivity`, `recordNativeActivity`, `storeActivity`, `readNativeActivity`)
- Modify: `server/features/sessions/native-session-binding.js:334-345` (`hookPush` uses the shared helper)
- Modify: `server/features/sessions/session-activity-merge.js` (`mergeActivity` passes `limit` when the reported idle wins)
- Modify: `server/features/sessions/session-activity.js` (result keeps `limit`)
- Modify: `server/features/requests/codex-launch.js:82-86` only if `update` does not already carry `failure`/`detail` into `recordNativeActivity`
- Test: `tests/unit/session-activity-hooks.test.js`, `tests/integration/native-session-activity.test.js`

**Interfaces:**
- Produces: `claudeLimitFailure(payload) -> { failure: "usage-limit", detail?: string } | null` exported from `native-session-activity.js` (true for `StopFailure` with `error` in `["rate_limit", "billing_error"]`; detail = first non-blank of `error_details`, `last_assistant_message`, sliced to 500). `hookPush` uses it instead of its inline check.
- Produces: `claudeHookActivity` for a limit `StopFailure` returns `{ state: "idle", event: "StopFailure", failure: "usage-limit", detail? }`.
- Produces: `recordNativeActivity({ state, event, background, at, failure, detail })` stores `limit: { detail: string|null }` only when `failure === "usage-limit"` and event is `StopFailure` or `turn/completed`.
- Produces: `readNativeActivity(...)` returns `{ state, event, background, at, limit? }` where `limit` is `{ detail: string|null }` only if the file's `limit` is an object whose `detail` is null or a string ≤ 500; otherwise omitted.
- Produces: `SessionActivity` results (and so `session.activity` in the `state` topic) carry `limit: { detail }` when the merged state is the reported `idle`.

- [ ] **Step 1: Write failing tests**
  - `session-activity-hooks.test.js`: `claudeHookActivity({ hook_event_name: "StopFailure", error: "rate_limit", last_assistant_message: "You've hit your Fable limit · resets Nov 20 at 4pm (Europe/Berlin)" })` deep-equals `{ state: "idle", event: "StopFailure", failure: "usage-limit", detail: "You've hit your Fable limit · resets Nov 20 at 4pm (Europe/Berlin)" }`; `StopFailure` with `error: "server_error"` gives `{ state: "idle", event: "StopFailure" }`.
  - `session-activity-hooks.test.js`: `mergeActivity({ pane: "idle", hook: { state: "idle", event: "StopFailure", at, limit: { detail: "x" } }, now })` includes `limit: { detail: "x" }`; with `pane: "working"` it has no `limit`.
  - `native-session-activity.test.js`: record a limit `StopFailure`, `readNativeActivity` returns `limit.detail`; then record `UserPromptSubmit` (later `at`) → no `limit`; a file with `limit: "bad"` or `limit: { detail: 5 }` → no `limit`; Codex `turn/completed` with `failure: "usage-limit", detail: "Try again at 14:00."` → `limit.detail` set.
- [ ] **Step 2:** `node --test tests/unit/session-activity-hooks.test.js tests/integration/native-session-activity.test.js` → new tests FAIL.
- [ ] **Step 3:** Implement the interfaces above.
- [ ] **Step 4:** Same command → PASS; also `node --test tests/integration/push-new-triggers.test.js tests/unit/cli-session-hooks.test.js tests/unit/session-activity.test.js` → PASS.
- [ ] **Step 5:** Commit `feat: remember a session's usage limit on its native activity`.

### Task 2: Mark limit replies in the transcript

**Files:**
- Create: `server/features/chat/limit-notice.js`
- Modify: `server/features/chat/history-parsers.js` (Claude text messages from limit records, Codex `codex-turn-error:*` with a usage-limit code) — at most a few lines, each calling the new module
- Modify: `server/features/chat/claude-conversation-record.js` only if the `api_error` system record needs to keep its status for detection
- Test: `tests/unit/chat-provider-errors.test.js`

**Interfaces:**
- Produces: `limitNotice(record) -> "usage-limit" | null` for Claude records: `type === "assistant" && isApiErrorMessage && error in ["rate_limit","billing_error"]`, or a converted `api_error` record whose status is 429.
- Produces: `codexLimitNotice(error) -> "usage-limit" | null` for `codexErrorInfo`/`codex_error_info` in `usageLimitExceeded`/`usage_limit_exceeded` (reuse the set from `server/features/requests/codex-activity.js`; export it there).
- Produces: chat messages gain `notice: "usage-limit"`; nothing else about them changes.

- [ ] **Step 1: Failing tests** in `chat-provider-errors.test.js`: the existing Codex expectation gains `notice: "usage-limit"` (both `normalizeCodex` and `normalizeCodexRecords`); a Codex error without a usage-limit code has no `notice`; a Claude record `{ type: "assistant", uuid: "l", isApiErrorMessage: true, error: "rate_limit", message: { id: "m", role: "assistant", content: [{ type: "text", text: "You've hit your Fable limit · resets Nov 20 at 4pm (Europe/Berlin)" }] } }` normalizes to one message with `notice: "usage-limit"`; the same record with `error: "server_error"` has no `notice`.
- [ ] **Step 2:** `node --test tests/unit/chat-provider-errors.test.js` → FAIL.
- [ ] **Step 3:** Implement; `history-parsers.js` stays ≤ 600 lines after `npx prettier --write`.
- [ ] **Step 4:** `node --test tests/unit/chat-provider-errors.test.js tests/unit/claude-queued-history.test.js tests/unit/claude-image-history.test.js` → PASS.
- [ ] **Step 5:** Commit `feat: mark usage-limit replies in session transcripts`.

### Task 3: Show "Limit reached" in the session list, header and transcript

**Files:**
- Modify: `web/features/sessions/sessionPresentation.js` (`sessionActivity`)
- Modify: `web/features/chat/live-status.js` (`liveActivity` keeps the limited label while state is `idle`)
- Modify: `web/app/SessionRow.jsx`, `web/features/chat/ChatObservability.jsx` (tone `warning` when limited)
- Modify: `web/features/chat/ChatTranscript.jsx` (or the assistant-message component it uses): a message with `notice === "usage-limit"` renders with the `.chat-limit-warnings` look and `role="status"`, text as plain text
- Modify: `server/lib/i18n/{de,en}/sessions.js` (`activityLimited`), `server/features/sessions/session-activity.js` label when `limit` is set
- Modify: `web/lib/i18n/{de,en}/…` catalogs (`limitReached`: DE "Limit erreicht", EN "Limit reached")
- Test: `tests/unit/` — the existing test file for `sessionPresentation` / `live-status` (find with `grep -rl "sessionActivity\|liveActivity" tests/unit`), or a new `tests/unit/session-limit-presentation.test.js`

**Interfaces:**
- Consumes: `session.activity.limit` (Task 1), `message.notice` (Task 2).
- Produces: `sessionActivity(session)` returns `{ state: "idle", label: <limitReached>, limited: true }` for a running session whose `activity.state === "idle"` and `activity.limit` is an object; `liveActivity(activity, live)` returns `limited: true` and the limited label when the merged state is `idle` and `activity.limited`.

- [ ] **Step 1: Failing tests:** `sessionActivity({ status: "running", tool: "claude", activity: { state: "idle", limit: { detail: "x" } } })` → `{ state: "idle", label: "Limit reached", limited: true }` (English catalog); same with `state: "working"` → no `limited`; `liveActivity({ state: "idle", label: "Limit reached", limited: true, observedAt: … }, { state: "idle", at: later })` keeps label and `limited`; a `live.state: "working"` drops them.
- [ ] **Step 2:** Run the test → FAIL.
- [ ] **Step 3:** Implement; tone mapping via `activityTone`/`StatusDot` tone `warning`.
- [ ] **Step 4:** Test → PASS; `npm run lint` on changed files.
- [ ] **Step 5:** Commit `feat: show sessions stopped at a usage limit`.

### Task 4: Limit bar with "Change model" and "Continue"

**Files:**
- Create: `web/features/chat/ChatLimitBar.jsx`
- Modify: `web/features/chat/ChatView.jsx` (render the bar in `.chat-compose-area` above `RequestPanel`, next to the existing `.chat-limit-warnings` block)
- Modify: `web/features/models/ModelControl.jsx` / `useModelControl.js` (new prop `openRequest: number`; when it increases, do what the trigger click does)
- Modify: `web/features/chat/useChatController.js` (export `sendText(value: string): Promise<void>` running the same guards and delivery as `submit`, without touching the composer draft)
- Modify: web i18n catalogs (`limitBarTitle`, `limitChangeModel` DE "Modell wechseln" / EN "Change model", `limitContinue` DE "Fortsetzen" / EN "Continue", `limitContinuePrompt` DE "Mach weiter." / EN "Please continue.")
- Test: `tests/browser/…spec.js` alongside the existing chat specs (find with `ls tests/browser | grep -i chat`), using the live stub with a session whose `activity` is `{ state: "idle", limit: { detail: "You've hit your Fable limit · resets Nov 20 at 4pm (Europe/Berlin)" } }`

**Interfaces:**
- Consumes: `sessionActivity(session).limited` (Task 3), `session.activity.limit.detail` (Task 1).
- Produces: `ChatLimitBar({ detail, disabled, onChangeModel, onContinue })` — `role="status"`, shows the title and `detail`, two buttons; `disabled` while busy, a request is pending, the model picker is pending, delivery is locked, or the session is not running.

- [ ] **Step 1: Failing browser test:** the bar shows the detail text; "Change model" opens the model picker panel (`aria-expanded="true"` on the model trigger); "Continue" sends exactly the continue prompt through the normal send API (assert the stubbed POST body); a session without `activity.limit` shows no bar.
- [ ] **Step 2:** `npm run test:e2e -- <spec>` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Spec → PASS in English; check the German page renders the DE strings.
- [ ] **Step 5:** Commit `feat: offer a model change and continue after a usage limit`.

### Task 5: Docs, translations, cleanup

**Files:**
- Modify: `docs/architecture.md` (native activity: the `limit` field and when it clears), `docs/chat-observability.md` and/or `docs/native-chat-delivery.md` (the limit bar), `docs/notifications.md` if it describes `session-limited` behaviour; `README.md`/`README.de.md` only if they list chat features that this changes.
- Modify: `web/lib/i18n/translation-lock.json`, `server/lib/i18n/translation-lock.json` via `npm run i18n:confirm`
- Delete: `docs/superpowers/specs/2026-11-17-session-limit-notice-design.md`, `docs/superpowers/plans/2026-11-17-session-limit-notice.md`

- [ ] **Step 1:** Update the docs above.
- [ ] **Step 2:** Review every new DE/EN pair; `npm run i18n:confirm`.
- [ ] **Step 3:** `npm run check` → PASS.
- [ ] **Step 4:** Delete the spec and plan; commit `chore: document the session limit notice`.
