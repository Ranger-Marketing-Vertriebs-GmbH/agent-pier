# CLI Delivery Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm chat deliveries to Claude Code and Codex from native acceptance events on the server instead of browser-side text matching.

**Architecture:** A pure matcher (`DeliveryAcceptance`) pairs a delivery's expectation (sent after Enter, image file names) with the first fitting acceptance event of the same session. Claude events come from the bridge mod's `prompt.submit` hook, Codex events from the app-server proxy (`item/started` `userMessage`). `ChatDelivery` turns a match into the new receipt status `accepted` (or a hook-blocked rejection) and pushes it over `session.deliveries`; the browser only renders.

**Tech Stack:** Node.js ES modules, `node:test`, React, tmux, Claude Code mod API, Codex app-server JSON-RPC.

**Spec:** `docs/superpowers/specs/2026-11-06-cli-delivery-confirmation-design.md`

## Global Constraints

- Node `^24.22.1 || >=26.12.1`; no new dependencies.
- Source and test files stay ≤ 600 lines (`npm run check:structure`).
- Every new or changed UI string in `web/lib/i18n/de/` and `web/lib/i18n/en/` with matching keys; run `npm run i18n:confirm` and commit `translation-lock.json`.
- Browser updates arrive only via the `session.deliveries` live topic; no new polling.
- Receipts stay at-most-once: no confirmation path may paste or press Enter.
- Tests never use the default tmux server or real sessions.
- Commits: `feat:`/`fix:`/`chore:` prefixes, English.
- Before the PR: delete this plan and the spec; update `docs/architecture.md`.

## Review Focus

- The owner types a prompt in the TUI right after a chat send: that event must not confirm the chat delivery when its image file names differ (Task 1 test `foreign event does not match`).
- Same text sent twice in a row: each event confirms exactly one delivery, oldest first (Task 1 test `two deliveries take events in order`).
- Acceptance event arrives before the receipt records Enter (mod flush is 100 ms, but the proxy is instant): it must still match (Task 1 test `buffered event matches a later expectation`).
- AgentPier restarts between Enter and event: the receipt stays `handed-off` and asks; it never flips to accepted from a stale buffer (Task 2 test `expectations do not survive a restart`).
- A blocked prompt whose CLI box holds more than our text: nothing is cleared and resend stays disabled (Task 3 test `foreign draft is never cleared`).

---

### Task 0: Verify dialog safety before building on it

The spikes showed an open permission prompt swallowing a paste and Enter approving the
pending tool. AgentPier's delivery guards dialogs (`models.guardInput(..., { nativeMenus: true })`,
`blockingScreen`, `waiting: "dialog"`). Prove it with a test before anything else.

**Files:**

- Test: `tests/integration/chat-delivery-dialog-safety.test.js`

- [ ] **Step 1:** Write tests that start a delivery against fixture screens (reuse fixtures from `tests/fixtures/` used by existing chat-delivery integration tests) showing (a) a Claude permission prompt and (b) a Codex approval dialog. Assert: no `paste-buffer` and no `send-keys Enter` reach the fake tmux, and the receipt is `pending` with `waiting: "dialog"` or `"request"`.
- [ ] **Step 2:** Run `node --test tests/integration/chat-delivery-dialog-safety.test.js`. Expected: PASS. **If it fails, stop**: report to the owner; the fix becomes its own ticket and lands first.
- [ ] **Step 3:** Commit `test: pin that chat delivery never types into a native approval dialog`.

### Task 1: Acceptance matcher

**Files:**

- Create: `server/features/chat/delivery-acceptance.js`
- Test: `tests/unit/delivery-acceptance.test.js`

**Interfaces:**

- Produces:
  - `class DeliveryAcceptance({ now = Date.now, onMatch })` where `onMatch(sessionId, deliveryId, outcome)` and `outcome = { kind: "accepted" | "dropped", queued?: boolean, reason?: string }`.
  - `ready(sessionId, source: "claude-mod" | "codex-proxy")` — the session has a live acceptance source.
  - `supports(sessionId): boolean`.
  - `expect(sessionId, { deliveryId, since: number, imageNames: string[] })`.
  - `report(sessionId, { kind, at: number, imageNames: string[] | null, imageCount: number, queued?, reason? })` (`imageNames` null when the source has no names, e.g. Codex).
  - `forget(sessionId)` (launch, stop, session end).
- Constants (exported): `EVENT_BUFFER_MS = 5000`, `EXPECTATION_TTL_MS = 600000`, `MAX_EXPECTATIONS = 32`, `MAX_EVENTS = 32`.

Matching rule: an event matches the **oldest** open expectation of the session with `event.at >= since`, `event.imageCount === imageNames.length`, and, when `event.imageNames` is not null, the same multiset of names. A non-fitting event is discarded (it is the owner's own prompt). An event with no open expectation is buffered for `EVENT_BUFFER_MS`; `expect()` first consumes a fitting buffered event. Matched expectations are removed. Expired ones are dropped silently. All state is in memory.

- [ ] **Step 1:** Write tests: `matches the first event after Enter`, `event before since does not match`, `foreign event does not match` (names differ), `codex event matches by count`, `two deliveries take events in order`, `buffered event matches a later expectation`, `buffer expires after EVENT_BUFFER_MS`, `dropped outcome carries reason`, `forget clears state`, `supports only after ready`.
- [ ] **Step 2:** Run `node --test tests/unit/delivery-acceptance.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the class in `server/features/chat/delivery-acceptance.js`.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit `feat: match chat deliveries to native acceptance events`.

### Task 2: `accepted` receipts in ChatDelivery

**Files:**

- Modify: `server/features/chat/chat-delivery.js` (statuses, `attempt`, `result`, constructor)
- Modify: `server/features/chat/chat-delivery-recovery.js` (recovery `tx.write` gets the same expectation)
- Modify: `server/application/services.js` (create one `DeliveryAcceptance`, pass to `ChatDelivery`)
- Test: `tests/integration/chat-delivery-acceptance.test.js`

**Interfaces:**

- Consumes: Task 1 `DeliveryAcceptance`.
- Produces:
  - Receipt status `"accepted"` (added to `statuses`), with `receipt.acceptedAt` and optional `receipt.queued`.
  - `ChatDelivery` constructor option `acceptance`.
  - `ChatDelivery.accept(sessionId, deliveryId, outcome)` — the `onMatch` target; idempotent; only `handed-off` or `uncertain` receipts change.
  - `result()` adds `confirmation: "events" | "text"` (events when `acceptance.supports(id)` at Enter time, stored on the receipt as `receipt.confirmation`) and `submittedAt`.

Expectation: in `onPhase("submit-intent")` record `since = Date.now()` and call `acceptance.expect(id, { deliveryId, since, imageNames })` with `imageNames = (await claudeImageMessage(text))?.images.map(path.basename) ?? []` (none for `isNativeSlashCommand`). Only when `acceptance.supports(id)`.

- [ ] **Step 1:** Write tests with a fake session and a real `DeliveryAcceptance`: `accepted event turns handed-off into accepted and publishes`, `uncertain receipt is confirmed by a later event`, `late event after ask timeout still confirms`, `accepted is terminal` (a second outcome is ignored), `expectations do not survive a restart` (new `ChatDelivery` + `DeliveryAcceptance`, event arrives, receipt stays `handed-off`), `session without a source keeps confirmation text`.
- [ ] **Step 2:** Run `node --test tests/integration/chat-delivery-acceptance.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement as above; wire `onMatch: (s, d, o) => chatDelivery.accept(s, d, o)` in `services.js`.
- [ ] **Step 4:** Run the test plus `node --test tests/integration/chat-delivery*.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: confirm chat deliveries from native acceptance`.

### Task 3: Hook-blocked prompts

**Files:**

- Modify: `server/features/chat/chat-delivery.js` (`accept` handles `kind: "dropped"`)
- Create: `server/features/chat/chat-delivery-blocked.js` (clear step, keeps `chat-delivery.js` < 600 lines)
- Test: `tests/integration/chat-delivery-blocked.test.js`

**Interfaces:**

- Produces: `clearBlockedPrompt({ sessions, id, text }): Promise<"cleared" | "foreign" | "empty">` in `chat-delivery-blocked.js`.
- Receipt on drop: `status: "rejected"`, `reason: "CHAT_HOOK_BLOCKED"`, `hookReason` (string ≤ 500 chars, optional), `released: true` only when the result was `"cleared"` or `"empty"`; `"foreign"` sets `reason: "CHAT_HOOK_BLOCKED_DRAFT"` and `released: false`.

Clear step: under `sessions.withChatInput`, read `nativePromptState(tool, fresh)`; clear only when it reports `text` equal to the delivered text (normalized with `normalizeChatText`) or a draft whose rows equal the text; Claude via `clearClaudeComposer`, Codex via the driver's clear (Ctrl-U per line; add `tui.clearPrompt` to the Codex driver if missing). Never Escape or Ctrl-C.

- [ ] **Step 1:** Tests: `blocked prompt is cleared and released`, `already empty box releases`, `foreign draft is never cleared`, `blocked uncertain receipt behaves the same`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: release hook-blocked chat messages back to the composer`.

### Task 4: Commands confirmed by screen

**Files:**

- Create: `server/features/chat/delivery-commands.js`
- Modify: `server/features/chat/chat-delivery.js` (after `submitted`)
- Test: `tests/unit/delivery-commands.test.js`, extend `tests/integration/chat-delivery-acceptance.test.js`

**Interfaces:**

- Produces: `unconfirmedCommand(tool, text): boolean` — true for `!…` and for local commands: Claude `/cost`, `/status`, `/clear`, `/compact`, `/context`, `/help`, `/model`, `/config`; Codex `/status`, `/compact`, `/model`, `/diff`, `/mention`.
- Receipt: `command: true`; after Enter, within the same `withChatInput` transaction, poll `nativePromptState` (every 100 ms, up to 2000 ms) for `empty` with no `blockingScreen`; then `status: "accepted"`. Otherwise stay `handed-off` (the ask state).

- [ ] **Step 1:** Unit tests for the classifier (both tools, prefixes, normal text, `/custom-skill` → false) and integration tests `command with empty prompt is accepted`, `command left in prompt stays handed-off`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; no `expect()` for commands.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: confirm local CLI commands from the cleared prompt`.

### Task 5: Claude source (bridge mod)

**Files:**

- Modify: `server/features/claude-mod/bridge-mod.js` (register `prompt.submit`)
- Modify: `server/features/claude-mod/claude-mod-events.js` (validate `prompt.accepted`, `prompt.dropped`)
- Modify: `server/features/claude-mod/claude-mod-bridge.js` (constructor option `onPrompt(sessionId, event)`; `hello` calls `onReady(sessionId)`)
- Modify: `server/application/services.js` (route to `acceptance.report` / `acceptance.ready`; `onLaunch` also calls `acceptance.forget`)
- Test: extend `tests/unit/claude-mod-events.test.js`, `tests/unit/bridge-mod.test.js` (or the existing mod tests), `tests/unit/claude-mod-bridge.test.js`

**Interfaces:**

- Mod event: `{ type: "prompt.accepted", at, images: string[] /* file names */, queued: boolean }` and `{ type: "prompt.dropped", at, reason?: string }`. Add both to the mod's `kept` set. Validation: names match `/^[^\0-\x1f\x7f\/]{1,255}$/`, ≤ 32 names, `reason` ≤ 500 chars.
- Hook: `on("prompt.submit", async ($, e, next) => { const r = await next(e); push(r?.drop ? dropped : accepted); return r; }).catch(pass)`. Only `origin.kind === "composer"`; image names from `e.attachments.filter(a => a.type === "image").map(a => a.filename)`; never modify `e` or `r`.
- Report to matcher: `{ kind, at, imageNames: images, imageCount: images.length, queued, reason }`.

- [ ] **Step 1:** Tests: validation accepts/refuses shapes; the mod pushes `prompt.accepted` with file names and `queued: Boolean(e.turnId)`, pushes `prompt.dropped` on `{drop}`, ignores non-composer origins, and passes `next` through unchanged when its own code throws; the bridge calls `onPrompt` and `onReady`.
- [ ] **Step 2:** Run the three test files. Expected: FAIL.
- [ ] **Step 3:** Implement and wire.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Manual check on a private tmux server (`tmux -L delivery-check`): send text, an image, png+zip, and a message while busy from a dev build; each confirms. Note results in the PR.
- [ ] **Step 6:** Commit `feat: report Claude prompt acceptance from the bridge mod`.

### Task 6: Codex source (proxy)

**Files:**

- Create: `server/features/requests/codex-prompt-acceptance.js`
- Modify: `server/features/requests/codex-proxy.js` (feed TUI→server and server→TUI messages)
- Modify: `server/features/requests/native-channel.js` (`prompt(event)` push), `server/features/requests/native-push.js` (validate `type: "prompt"` and `type: "prompt-ready"`)
- Modify: `server/application/services.js` (`onNative` routes them)
- Test: `tests/unit/codex-prompt-acceptance.test.js` (fixtures distilled from the spike's `rpc-evidence.jsonl`, stored in `tests/fixtures/codex-prompt-acceptance/`)

**Interfaces:**

- Produces: `codexPromptAcceptance(onEvent): { outgoing(message), incoming(message) }`.
  - `outgoing`: `turn/start` or `turn/steer` with non-null `params.clientUserMessageId` → remember `{ threadId, imageCount: params.input.filter(i => i.type === "image" || i.type === "localImage").length }` by id (≤ 64 entries).
  - `incoming`: `item/started` with `params.item.type === "userMessage"` and a remembered `clientId` → `onEvent({ kind: "accepted", at: Date.now(), imageNames: null, imageCount })`; `hook/completed` with `status: "blocked"` for a `turn/start` whose turn completes without a `userMessage` → `{ kind: "dropped", reason }`. A blocked `turn/steer` emits nothing.
  - Ignore requests with `clientUserMessageId: null` (title generation).
- Proxy sends `channel.prompt({ type: "prompt-ready" })` when the TUI connects.

- [ ] **Step 1:** Tests from fixtures: text, multi-line, image, image+file, steer while busy, blocked start → dropped, blocked steer → nothing, title turn ignored, unknown shapes ignored without throwing.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; wrap both hooks in try/catch like `hooks.outgoing` so native traffic is never affected.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Manual check on a private tmux server as in Task 5, Step 5.
- [ ] **Step 6:** Commit `feat: report Codex prompt acceptance from the app-server proxy`.

### Task 7: Chat UI

**Files:**

- Modify: `web/features/chat/ChatDeliveryStatus.jsx`, `web/features/chat/useChatDelivery.js`, `web/features/chat/chat-draft.js`, `web/features/chat/native-delivery-state.js`
- Modify: `web/lib/i18n/de/chat.js`, `web/lib/i18n/en/chat.js` (+ messages export)
- Test: `tests/unit/chat-delivery-status.test.js` (or the existing chat delivery unit tests), `tests/browser/chat-delivery.spec.js`

**Interfaces:**

- Consumes: `status: "accepted"`, `confirmation`, `submittedAt`, `command`, `reason: "CHAT_HOOK_BLOCKED" | "CHAT_HOOK_BLOCKED_DRAFT"`, `hookReason`.
- Behaviour:
  - `accepted`: no notice (the message shows as a sent chat bubble until the transcript row replaces it); for `command: true` show `commandHandedOff` for 3 s.
  - `handed-off` with `confirmation: "events"`: "An CLI gesendet …" until `submittedAt + 8000`, then the ask state `askCheck` with the existing inspect and resend buttons (client timer, no fetch).
  - `confirmation: "text"`: keep today's `nativeDeliveryStates` path unchanged.
  - Hook block: `hookBlocked` (+ `hookReason`), resend button enabled when `released`; `hookBlockedDraft` without resend.
- New keys (de/en): `commandHandedOff` ("Befehl übergeben" / "Command handed over"), `askCheck` ("Keine Bestätigung der CLI. Bitte prüfen oder erneut senden." / "The CLI has not confirmed. Check or resend."), `hookBlocked` ("Von einem Hook blockiert" / "Blocked by a hook"), `hookBlockedDraft` ("Von einem Hook blockiert. Der Text steht noch im Eingabefeld der CLI." / "Blocked by a hook. The text is still in the CLI prompt.").

- [ ] **Step 1:** Unit tests for the rendered state per status/confirmation/time; extend the browser spec with the live stub: an `accepted` push removes the notice; a `handed-off` past 8 s shows the ask text; a blocked delivery offers resend.
- [ ] **Step 2:** Run `node --test tests/unit/chat-delivery-status.test.js` and `npx playwright test tests/browser/chat-delivery.spec.js`. Expected: FAIL.
- [ ] **Step 3:** Implement; add keys; `npm run i18n:confirm -- chat`.
- [ ] **Step 4:** Run tests + `npm run lint`. Expected: PASS. Check the UI in English.
- [ ] **Step 5:** Commit `feat: show native delivery confirmation in the chat`.

### Task 8: Other consumers

**Files:**

- Modify: `server/features/tickets/ticket-service.js`, `sequence-start.js`, `sequence-fixes.js`; `server/features/assistants/coding-sessions/session-steering.js`; `server/features/audit/audit-vocabulary.js`, `audit-agent-session-details.js`; MCP/HTTP docs that list delivery statuses.
- Test: extend the existing tests of each module (`tests/unit/ticket-*`, `tests/unit/session-steering*`, `tests/unit/audit-*`).

**Interfaces:**

- `accepted` counts as success everywhere `handed-off` did; `handed-off` remains "delivering" (in `DELIVERING` sets); `rejected` with `CHAT_HOOK_BLOCKED*` is a failure: a ticket start fails with that reason, steering reports `rejected`, audit records `accepted` and `hook-blocked`.

- [ ] **Step 1:** Tests per module for `accepted` and a hook block.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: treat native acceptance as delivery success across tickets, steering and audit`.

### Task 9: Docs and cleanup

**Files:**

- Modify: `docs/architecture.md` (Chat delivery and Live channel: acceptance sources, statuses, ask timeout), README/README.de if they mention delivery states.
- Delete: this plan and the spec.

- [ ] **Step 1:** Update docs; grep `docs/ README*` for "handed-off", "CLI-Bestätigung", "Zustellanzeige".
- [ ] **Step 2:** `npm run check`. Expected: PASS.
- [ ] **Step 3:** Delete `docs/superpowers/plans/2026-11-06-cli-delivery-confirmation.md` and `docs/superpowers/specs/2026-11-06-cli-delivery-confirmation-design.md`.
- [ ] **Step 4:** Commit `chore: document native delivery confirmation`.
