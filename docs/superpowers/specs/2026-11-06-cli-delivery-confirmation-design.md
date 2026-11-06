# CLI delivery confirmation from native events

Date: 2026-11-06 · Status: ready for owner review

## Why

After a chat message is handed to a coding CLI, the chat shows "An TUI gesendet ·
CLI-Bestätigung steht aus" (receipt status `handed-off`) until the **browser** finds the
message in the CLI's native history by comparing text. The CLIs rewrite prompts
(Claude: image paths become `[Image #N]` chips that move to the front, long pastes are
wrapped in `<pasted_content>`, queued prompts lose their image paths; Codex: image
placeholders, steer vs. queue). Every rewrite needs another reconstruction rule in
`web/features/chat/delivery-content.js`, `web/features/chat/native-delivery-state.js`
and `server/features/chat/claude-image-history.js`, and every gap leaves a message
stuck.

Observed failure (2026-11-06): a message with one PNG and two ZIP uploads was accepted
by Claude, but the reconstructed text ordered the paths `zip, zip, png` instead of the
sent `png, zip, zip`, so it never confirmed. The owner saw the notice forever, guessed
it had worked, and could only remove it with "Zustellanzeige schließen".

The owner wants the notice to be trustworthy: confirm quickly and disappear on its own
when the CLI took the message, say clearly when it did not, and make the unclear case as
rare as possible.

## Goals

- A message the CLI accepted is confirmed within seconds and the notice disappears on
  its own, for text, images, other files and any mix, in Claude Code and Codex.
- "Accepted into the CLI's own queue" counts as delivered (owner decision).
- Confirmation comes from an unambiguous CLI event on the server, not from comparing
  text. The server sets the result and pushes it over the existing
  `session.deliveries` live topic.
- A message the CLI did not accept is shown as not delivered, with a way to resend.
- When neither confirmation nor refusal arrives, the notice stays and, after a while,
  actively asks the owner to check or resend (owner decision). This case must be rare.

## Non-goals

- Changing how text is pasted into the TUI (tmux bracketed paste + Enter stays).
- Confirming that the agent _processed_ the message; acceptance is enough.
- Other CLIs (OpenCode etc.) keep their current confirmation path.

## Anti-goals (failure even if it technically works)

- A false "delivered" for a message the CLI did not take (for example a prompt blocked
  by a hook, or text swallowed by a dialog).
- New per-format text reconstruction rules.
- A notice that is stuck again for a common case.

## Evidence (spikes, 2026-11-06)

Throwaway spikes ran Claude Code 2.1.319 and Codex CLI 0.164.0 on private tmux servers.

### Claude Code

- `UserPromptSubmit` hook is **not** sufficient: it fires before a blocking hook drops
  the prompt; for a prompt queued while a turn runs it fires at enqueue time with the
  _running_ turn's `prompt_id`; a queued prompt the user later removes leaves no trace.
  Its `prompt` field has image chips only, no paths.
- The bridge mod's `prompt.submit` event (mod API, Claude Code 2.1.287+, which
  AgentPier already loads via `server/features/claude-mod/bridge-mod.js`) is the
  reliable signal: `await next(e)` resolves once the prompt was submitted **or queued**,
  and returns `{ drop }` when a hook blocks it. The event carries structured
  `attachments` (`type: "image"`, `mediaType`, `filename`), `turnId` (set when queued),
  `origin.kind` and `command { name, args }`. Types: the mod's
  `types/claude-code/index.d.ts` (prompt.submit section).
- No submit event for bash mode (`!…`) or local slash commands (`/cost`, `/status`).
- An open dialog swallowed the paste in the raw spike; AgentPier's delivery already
  guards menus and dialogs (`nativeMenus`, `closeMenus`, `waiting: "dialog"`), which
  the spike did not use. See "Dialog safety" below.

### Codex

- AgentPier runs `codex app-server --stdio` behind its own proxy
  (`server/features/requests/codex-proxy.js`, `codex-launch.js`) with the TUI attached
  via `--remote`. Every submitted prompt sends `turn/start` (idle) or `turn/steer`
  (busy; AgentPier's Enter steers) carrying a TUI-generated `clientUserMessageId`.
- **Acceptance proof:** the server notification `item/started` with
  `item.type: "userMessage"` and `clientId` equal to that `clientUserMessageId`. The
  rollout also stores `item_completed UserMessage client_id`.
- `UserPromptSubmit` and `turn/started` also fire for a prompt a hook blocks; then no
  `userMessage` item follows and `hook/completed` reports `status: "blocked"`.
- Images arrive as inline data URLs in `input`; the count is available.
- Tab-queued messages stay inside the TUI with no signal until dequeued. AgentPier
  presses Enter (steer), so this does not affect AgentPier deliveries.
- Ignore the hidden title-generation turn (separate thread, `clientUserMessageId: null`).
- `/status` produces nothing; `/compact` produces `thread/compact/start` but no
  `userMessage`.
- The app-server protocol is marked experimental.

Spike scripts and raw logs:
`/private/tmp/claude-501/-Users-d-kaulig-Projects-agent-pier/c1adcd55-5a15-4582-9cdf-29a0c8d7efcd/scratchpad/spike-claude/`
and `.../spike-codex/` (temporary; copy what the plan needs into test fixtures).

## Design

### Overview

1. Delivery hands the message to the TUI as today and records the receipt as
   `handed-off` with an **expectation**: the attachment counts it sent (images, other
   files), whether it is a command (below), and the moment Enter was sent.
2. A per-CLI **acceptance source** on the server reports native submit events for the
   session: `accepted` (with image count and, where available, file names) or
   `dropped`.
3. The server matches the **first** acceptance event in that session after the
   delivery's Enter, while the delivery still holds the session's input lock, to the
   delivery. It checks only the image count (and, for Claude, that each uploaded image
   file name appears in the event's attachments). No text comparison.
4. On a match the receipt becomes **accepted** (new terminal status); on `dropped` it
   becomes rejected (see "Blocked by a hook"). The write goes through the existing
   receipt write path so `session.deliveries` pushes it.
5. The browser renders the server's status; the notice disappears on `accepted`.

### Acceptance sources

- **Claude Code (mod available):** the bridge mod wraps `prompt.submit`, awaits
  `next(e)`, and forwards `{ kind: "accepted" | "dropped", images, filenames, queued:
Boolean(e.turnId), origin, command }` over the existing bridge socket
  (`claude-mod-socket.js`) to the server. It never alters or delays the prompt.
- **Codex:** the proxy watches window→server `turn/start` / `turn/steer` requests
  (`clientUserMessageId`, thread id, image count) and server→window `item/started`
  `userMessage` notifications. A `clientId` that matches a request on the session's
  thread is `accepted`; a request whose turn completes with a blocked
  `hook/completed` and no `userMessage` is `dropped`.
- **Fallback (Claude Code without the mod, Codex without the proxy, other CLIs):**
  keep the current path unchanged. Retire the text matcher only where an acceptance
  source exists.

### Commands without an acceptance event (owner decision)

- Delivery classifies the message at send time: text starting with `!`, or a known
  local command from a per-CLI list (initially Claude: `/cost`, `/status`, `/clear`,
  `/compact`, …; Codex: `/status`, `/compact`, …).
- For these only, confirmation is a **screen check** after Enter: the prompt box is
  empty and no dialog or menu is open. Then the receipt becomes accepted and the notice
  shows "Befehl übergeben" briefly before hiding. If the text is still in the prompt box
  or a dialog appeared, the notice stays and asks (see below).
- The screen is never used to confirm ordinary messages.

### Unclear outcome

- If no acceptance or drop arrives within a timeout (builder's call; a few seconds after
  Enter for idle sessions), the receipt stays `handed-off` and the notice changes to an
  active question with the existing "Übergabe prüfen" and resend actions.
- "Zustellanzeige schließen" stays available but should no longer be the normal way out.

### Concurrent typing and duplicates

- The delivery holds the session input lock from paste until the acceptance event or
  timeout, so AgentPier itself never interleaves two deliveries.
- A prompt the owner types directly in the TUI at the same moment cannot be told apart
  by id (both are composer prompts). Matching by "first event after our Enter" plus the
  image-count check is accepted as good enough; document the residual risk.

### Dialog safety

The raw spikes showed that an open permission prompt can swallow a paste and that the
following Enter approved the pending tool, in both CLIs. AgentPier's delivery already
detects dialogs and menus before pasting. The plan's first task verifies this with a
test against the real guard; if it can happen in AgentPier, it becomes a separate
ticket and is fixed first, independent of this design.

### Blocked by a hook (owner decision)

The owner often works from a phone, where the CLI itself is awkward to use, so a blocked
message must be fully handled from the chat:

- Claude puts a blocked prompt back into its own prompt box. On `dropped`, AgentPier
  clears the CLI prompt box, but only when a screen check shows it holds exactly the
  delivered text (never clear anything else), and releases the text and attachments
  back to the chat composer.
- The notice says the message was blocked by a hook (with the hook's reason when the
  event carries one) and offers **resend** directly, plus editing in the composer.
- If the prompt box cannot be proven to hold only our text, AgentPier does not clear
  it; the notice says the text is still in the CLI and offers resend only after the
  box is empty, so a resend never doubles a prompt.

### Other consumers of delivery status (owner decision: in scope)

Tickets (`ticket-service.js`, `sequence-start.js`, `sequence-fixes.js`), agent steering
over MCP (`session-steering.js`) and audit (`audit-vocabulary.js`,
`audit-agent-session-details.js`) treat `handed-off` as success or in progress today.
They move to the new model: accepted is success, a hook block is a failure (a blocked
ticket start fails instead of counting as started), and the unclear state stays
pending. Their API contracts, docs and tests change in the same work.

### Matching window (design author's call)

- Matching is tied to a per-delivery window, not to the session input lock. The
  delivery releases the lock shortly after Enter (both spikes saw the acceptance event
  within milliseconds, also for a busy Codex steer and a queued Claude prompt), so
  terminal controls are never blocked while waiting.
- An acceptance that arrives after the "ask" timeout still turns the receipt into
  accepted: the event is the truth, the timeout only changes the wording.
- An event whose image count or file names do not fit is treated as a prompt the owner
  typed in the TUI: it is ignored and the delivery keeps waiting until its timeout. A
  wrong "delivered" is worse than an "ask".
- `uncertain` receipts are in scope: an acceptance event in their window confirms them
  the same way, which removes another common stuck notice.
- A blocked Codex `turn/steer` gives no reliable drop signal; it falls through to "ask".

## Constraints

- Server state reaches the browser over the live channel (`session.deliveries`); no
  new polling.
- Receipts keep their at-most-once semantics; a confirmation never triggers a resend.
- New UI text in German and English with `npm run i18n:confirm`.
- Files stay under 600 lines; tests use isolated tmux servers and fixtures, never real
  sessions.
- Update `docs/architecture.md` (delivery and live channel) in the same change.

## Left to the builder

- The exact receipt status name and migration of existing `handed-off` receipts.
- The timeout values and the wording of the "ask" state.
- How the mod and proxy events are buffered so an event that arrives before the
  receipt write is not lost.
- Which parts of the browser text matcher can be deleted once both sources are live,
  and whether the fallback stays for older Claude Code versions.
- Test fixtures distilled from the spike logs.
