# Native chat delivery observations

AgentPier distinguishes a durable terminal handoff from an observed native queue and native consumption. Transport receipts and retry guards remain independent from display observations. No observation sends input, retries Enter or changes a delivery's custody status.

## Display states

- **Sent to TUI · awaiting CLI confirmation:** bracketed paste and Enter completed, but native acceptance has not been established.
- **In the CLI queue:** the current native queue region contains one complete matching message in the same launch. Codex's own next-tool-call hint is shown only for Codex.
- **Accepted by CLI:** a fresh, matching native user record exists. For OpenCode, an assistant record must additionally name that native user message as its parent. This does not mean the agent finished the requested work.
- Existing uncertain/rejected states retain their explicit inspection and guarded recovery actions. Confirmed queue rows do not invite redelivery.

The status stays beside the native message when history arrives before consumption. It also remains visible on the outgoing card before a native row exists. German and English catalogs carry the same controls and explanations.

## Evidence and scope

Each new handoff/recovery records a private observation baseline: exact payload hash, server start time, the native queue before writing, launch/pane identity and the known native conversation ID. The launch identity stays stable through Codex's first receipt, but changes with a new native process or session restart. A known conversation ID must still match after a clear/resume.

The queue adapter requires native composer geometry, styling and the current queue region. It transmits at most 20 text hashes, never raw terminal output. It does not infer queue acceptance from a generic working spinner, elapsed time, an empty composer or an unrelated transcript substring. Identical active texts and entries already present before a send remain ambiguous. Wrapped or collapsed message bodies, unsupported themes and clipped/pasted summaries stay unconfirmed; a wrapped Codex queue heading is supported.

Native history matching is display evidence, not a cryptographic delivery acknowledgement. Matching consumes each native row at most once and checks exact text, launch, conversation, baseline IDs and a timestamp after the send attempt. Claude and OpenCode expose native message timestamps. Codex's native UUIDv7 user-item identifier supplies its creation time where the history item omits an explicit timestamp. Missing timestamps cannot establish consumption. Old rows loaded by pagination must not confirm a new equal-text message.

OpenCode can persist a user message while it is still queued. A plain history-text match is therefore insufficient. The page/export adapters preserve the native assistant `parentID` relationship; unsupported or incomplete pages remain unconfirmed rather than inferring consumption from message order.

## Streaming and lifecycle

A shared tmux control client watches output for each subscribed running coding session. It never writes commands to its stdin or injects keys. The `ignore-size` flag keeps it out of terminal sizing. Do not add tmux's `read-only` flag: tmux can select that client for an external `paste-buffer`, causing ordinary Chat delivery to fail with `client is read-only`. The real input probe and synthetic regression exercise this case.

Output hints are coalesced for 200 ms. A bounded current-pane capture derives queue hashes and the current launch identity. Only changed observations are published through the existing Chat WebSocket, shared by all tabs. Queue transitions also invalidate the history cache: SQLite WAL writes do not reliably trigger every expected filesystem notification on every platform. Ordinary output does not cause repeated history reads when the queue is unchanged.

The last subscriber disconnect disposes the control client. Session/account changes, stopped sessions and failed captures clear current observations. Stream disconnects clear the browser's live evidence; reload/reconnect reconstruct it from the current stream without resending. The existing shared recovery timer re-establishes watchers; no new browser polling loop is added.

## Native spike, 2026-09-12

Disposable profiles, a private tmux socket and a loopback mock provider were used; no real sessions, accounts or provider credentials were used. Tested CLIs: Codex 0.153.4, Claude Code 2.1.269 and OpenCode 1.18.30, with tmux 3.7c on macOS ARM64.

Reproduce a narrow single-message queue/consumption probe:

```sh
node scripts/probe-chat-tui.mjs --native --tool codex --local-mock --bound --http --samples 1 --queue-spike --narrow-queue
```

Replace `codex` with `claude` or `opencode`. The provider holds the first response for eight seconds. The probe sends a second message via real HTTP, observes the native queue via the real WebSocket, verifies unchanged terminal dimensions, then checks native consumption using the same state function as Chat. It also exercises the existing multiline, long-message, image and guarded recovery cases after restoring the normal terminal width.

Use `--multi-queue` instead of `--narrow-queue` for multiple distinct and duplicate pending messages. All three CLIs expose the duplicate queue entries; the application intentionally does not assign one indistinguishable queue entry to an individual delivery. The mock provider chooses the last user marker without deduplicating repeated markers.

Regression fixtures contain only synthetic native frames. Unit/integration coverage includes ambiguous text, old history, scope changes, early OpenCode history, shared WebSocket delivery, normal input with the observer attached, unchanged dimensions and disposal. Mobile browser tests exercise both locales, reload without resending, native-row placement and the queue-to-consumed transition in Chromium and WebKit.
