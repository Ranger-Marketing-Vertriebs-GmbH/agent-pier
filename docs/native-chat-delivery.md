# Native chat delivery observations

AgentPier distinguishes a durable terminal handoff from an observed native queue and native consumption. Transport receipts and retry guards remain independent from display observations. No observation sends input, retries Enter or changes a delivery's custody status.

## Display states

- **Sent to TUI · awaiting CLI confirmation:** bracketed paste and Enter completed, but native acceptance has not been established.
- **In the CLI queue:** the current native queue region contains one complete matching message in the same launch. Codex's own next-tool-call hint is shown only for Codex.
- **Accepted by CLI:** a fresh, matching native user record exists. For OpenCode, an assistant record must additionally name that native user message as its parent. This does not mean the agent finished the requested work.
- **Waiting for the open request / a dialog in the TUI / an earlier message:** the message is held (`pending` with `waiting`) until an AgentPier request is answered or a recognized native question or menu is gone, then delivered automatically. It is never refused for terminal state; see `docs/direct-chat-tui-validation.md` ("Chat never blocks on terminal state"). A held message does not lock the composer: later messages queue behind it on the server (per session, first in, first out, across tabs and devices). While its text has not reached the terminal it offers **Cancel sending**, which returns it for editing; pasted text can only be removed in the TUI ("Open TUI").
- Informational notices on a handoff (sent together with an existing terminal draft, unreadable prompt, a Claude menu closed with Esc, images possibly missing) are shown beneath the status and never block the composer.
- Existing uncertain/rejected states retain their explicit inspection and guarded recovery actions. A rejected message (nothing reached the terminal) returns its text to the composer. Confirmed queue rows do not invite redelivery.

The status stays beside the native message when history arrives before consumption. It also remains visible on the outgoing card before a native row exists. German and English catalogs carry the same controls and explanations.

## Evidence and scope

Each new handoff/recovery records a private observation baseline: exact payload hash, server start time, the native queue before writing, launch/pane identity and the known native conversation ID. The launch identity stays stable through Codex's first receipt, but changes with a new native process or session restart. A known conversation ID must still match after a clear/resume.

The queue adapter requires native composer geometry, styling and the current queue region. Claude Code 2.1.2xx lists queued prompts unindented in gray, separated by blank rows and followed by a `ctrl+x ctrl+s to send now` hint; the adapter reads this layout and the older indented one. In panes down to about 24 columns, Claude truncates the queued-messages placeholder with `…` and wraps the send-now hint; with `NO_COLOR` or `FORCE_COLOR=0` the same layout appears without styling. Both are recognized; without color the queued placeholder counts only while the footer still shows its empty-prompt hint (`esc to interrupt`), so queues in colorless panes narrower than about 34 columns stay unconfirmed. Claude wraps queued rows after the pane width minus three cells instead of clipping them, also for long unbroken tokens, CJK and emoji; a single row up to that width is confirmed. Entries are separated by one blank row, so a wider gap ends the queue region. Multi-row queue entries remain unconfirmed because wrapping and embedded newlines look alike. It transmits at most 20 text hashes, never raw terminal output. It does not infer queue acceptance from a generic working spinner, elapsed time, an empty composer or an unrelated transcript substring. Identical active texts and entries already present before a send remain ambiguous. Wrapped or collapsed message bodies, unsupported themes and clipped/pasted summaries stay unconfirmed; a wrapped Codex queue heading is supported.

Native history matching is display evidence, not a cryptographic delivery acknowledgement. Matching consumes each native row at most once and checks exact text, launch, conversation, baseline IDs and a timestamp after the send attempt. Claude and OpenCode expose native message timestamps. Codex's native UUIDv7 user-item identifier supplies its creation time where the history item omits an explicit timestamp. Missing timestamps cannot establish consumption. Old rows loaded by pagination must not confirm a new equal-text message.

OpenCode can persist a user message while it is still queued. A plain history-text match is therefore insufficient. The page/export adapters preserve the native assistant `parentID` relationship; unsupported or incomplete pages remain unconfirmed rather than inferring consumption from message order.

## Streaming and lifecycle

A shared tmux control client watches output for each subscribed running coding session. It never writes commands to its stdin or injects keys. The `ignore-size` flag keeps it out of terminal sizing. Do not add tmux's `read-only` flag: tmux can select that client for an external `paste-buffer`, causing ordinary Chat delivery to fail with `client is read-only`. The real input probe and synthetic regression exercise this case.

Output hints are coalesced for 200 ms. A bounded current-pane capture derives queue hashes and the current launch identity. Only changed observations are published through the existing Chat WebSocket, shared by all tabs. Queue transitions also invalidate the history cache: SQLite WAL writes do not reliably trigger every expected filesystem notification on every platform. Ordinary output does not cause repeated history reads when the queue is unchanged.

The last subscriber disconnect disposes the control client. Session/account changes, stopped sessions and failed captures clear current observations. Stream disconnects clear the browser's live evidence; reload/reconnect reconstruct it from the current stream without resending. The existing shared recovery timer re-establishes watchers; no new browser polling loop is added.

## Claude image messages

Claude image messages are pasted in two steps: first all attached image paths, then, after the prompt shows that many image chips, the remaining text, then one Enter. Claude places chips before the text either way, so chips and text keep their order, and a long text can no longer scroll chips out of a short pane before they are counted. Unlike a single paste, which silently dropped blank lines and path-like lines that were not chips, the text keeps those lines. Quoted absolute image paths count as images, as Claude turns them into chips too. The receipt journal records the extra steps (`images-pasted`, `text-intent`); a question between the two pastes holds the text, and recovery continues with only the text when exactly the chips are visible and submits only when exactly chips plus text are visible, comparing chips independent of their session numbering. If an attached image file was deleted in the meantime, recovery is blocked with its own reason. Details and the validation matrix are in `docs/direct-chat-tui-validation.md`.

## Native spike, 2026-09-12

Disposable profiles, a private tmux socket and a loopback mock provider were used; no real sessions, accounts or provider credentials were used. Tested CLIs: Codex 0.153.4, Claude Code 2.1.269 and OpenCode 1.18.30, with tmux 3.7c on macOS ARM64.

Reproduce a narrow single-message queue/consumption probe:

```sh
node scripts/probe-chat-tui.mjs --native --tool codex --local-mock --bound --http --samples 1 --queue-spike --narrow-queue
```

Replace `codex` with `claude` or `opencode`. `--narrow-queue` uses 50 columns; `--narrow-queue=24` selects another width. The provider holds the first response for eight seconds. The probe sends a second message via real HTTP, observes the native queue via the real WebSocket, verifies unchanged terminal dimensions, then checks native consumption using the same state function as Chat. It also exercises the existing multiline, long-message, image and guarded recovery cases after restoring the normal terminal width.

Use `--multi-queue` instead of `--narrow-queue` for multiple distinct and duplicate pending messages. All three CLIs expose the duplicate queue entries; the application intentionally does not assign one indistinguishable queue entry to an individual delivery. The mock provider chooses the last user marker without deduplicating repeated markers.

Regression fixtures contain only synthetic native frames. Unit/integration coverage includes ambiguous text, old history, scope changes, early OpenCode history, shared WebSocket delivery, normal input with the observer attached, unchanged dimensions and disposal. Mobile browser tests exercise both locales, reload without resending, native-row placement and the queue-to-consumed transition in Chromium and WebKit.

## Known limitations of held messages

- Holds live in the server process. A restart ends them; the receipt then reads uncertain with the reason it waited for, states whether the text was typed, and "Deliver again" holds again if the TUI is still busy.
- A menu the user opens in the TUI while a message waits is closed with Escape when it is the rewind selector or model picker (once per message); other menus keep the message waiting.
- Session-level refusals (stopped, reloading, replaced runtime, account switch) still end a message instead of holding it.
- A question that opens in the instant between a paste and a fresh check of the prompt is handled by the held Enter below; a paste that races a dialog drawn before the check can still land in the dialog, as on main.

## Codex and OpenCode prompt guards

Recognized drafts are replaced before sending; native menus and permission dialogs
hold delivery until the user answers or closes them. Visible lost pastes and stuck
submits remain unconfirmed. See [native prompt validation](native-chat-prompt-validation.md)
for the isolated spike, tested CLI versions, terminal sizes and image preparation.

Codex and OpenCode paste each image path individually and await its native chip
before adding the text. A partial image batch is never replayed automatically;
once all images were pasted, recovery can continue with only the missing text.
