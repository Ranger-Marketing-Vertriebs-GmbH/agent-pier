# Chat and session audit follow-up

The seven findings from the September 12 audit were reproduced against main commit
`a41845ba9a0421cffbae87b6541fea28a25c49cd` before applying these changes. The original
audit used version 1.17.0; its reproduction scripts deliberately have mixed success
semantics, so the repository tests below assert the corrected behavior instead.

| Finding     | Corrected behavior                                                                                                                                                                                          | Regression coverage                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| AP-AUDIT-01 | A successful PTY write no longer makes an older empty screen authoritative. Unobserved manual input blocks chat injection; a visible draft returns to the existing composer/recovery checks.                | `terminal-chat-render-race.test.js`, `manual-input-guard.test.js` |
| AP-AUDIT-02 | A legacy handoff cannot match a native row older than the locally created delivery. Loading older pages cannot persistently hide the new notice. Current receipts retain their server observation boundary. | `chat-historical-delivery.test.js`                                |
| AP-AUDIT-03 | Codex's latest paginated view includes rollout task and context metadata. Complete appended records update a bounded cache; replacement or truncation resets it.                                            | `codex-page-metadata.test.js`                                     |
| AP-AUDIT-04 | OpenCode pages and export fallback respect message and part revert boundaries. Undo/redo invalidates previous cursors.                                                                                      | `opencode-revert.test.js`, `opencode-history-pages.test.js`       |
| AP-AUDIT-05 | A stopped session ends its stream only after a ready, non-stale snapshot finishes indexing. A provisional cursor remains usable when indexing fails.                                                        | `chat-ended-recovery.test.js`, `claude-index-stream.test.js`      |
| AP-AUDIT-06 | Model HTTP requests have a 15-second local deadline. After an uncertain mutation, a fresh status read reconciles the picker before unblocking chat; the mutation is never automatically repeated.           | `model-control.spec.js` in German and English                     |
| AP-AUDIT-07 | Launches reserve global capacity and account login exclusivity before asynchronous preparation. Reservations are released on success and failure.                                                           | `session-launch-reservations.test.js`                             |

A separately reported stop failure is also covered: stopping a replacement awaiting
native verification now drains reload work and stops the process directly, instead
of first attempting the unsupported cancellation of an active reload.
`session-stop-reloading.test.js` exercises the HTTP route with an isolated process;
`session-reload.test.js` checks pending-work cleanup.

## Validation and limits

Validation includes `npm run check`, the targeted HTTP and terminal regressions,
and the model-control/chat-sync browser suites in Chromium and WebKit. Browser
coverage uses controlled API fixtures; the terminal race uses real private tmux and
PTY transport with a synthetic TUI that renders 700 ms after consuming input. It
does not measure the incidence of this race in particular provider CLI versions.
All automated process tests use disposable data directories and private sockets.

The manual-input guard deliberately retains uncertainty when the native composer
cannot be inspected, including collapsed drafts. A request timeout bounds browser
waiting; it does not establish that a server-side mutation was cancelled. Codex's
initial metadata scan yields between bounded chunks, and subsequent scans read
appends; supplemental metadata can remain unavailable when the rollout cannot be
verified or read. No new runtime dependency or installer change is required.
