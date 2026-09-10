# Chat streaming and lazy history

## Implemented architecture

The browser opens the authenticated `/api/sessions/:id/chat-stream` WebSocket.
Each connection starts with a bounded full snapshot and sequence 1, followed by
ordered message deltas and complete metadata. Reconnects start from a fresh full
snapshot; sequence gaps discard that connection. Normal operation does not poll
HTTP. Up to three HTTP recovery reads keep the chat usable during connection
failures while the socket reconnects with exponential backoff. Hidden tabs release
their connection; returning to the tab reconciles with the server.

`ChatStreams` shares one serialized source reader per watched session across tabs.
Native storage filesystem events and AgentPier binding events trigger a debounced
refresh. A 30-second server recovery timer repairs missed filesystem events and
watchers for directories created after startup. Readers and watchers are released
when the final subscriber disconnects. Login expiry, origin checks, heartbeat,
backpressure, terminal socket coexistence and shutdown use isolated integration
coverage. The stream transports observations; sending messages continues through
the existing native delivery queue.

The initial native history page contains at most 50 messages. Codex uses
`thread/read` without turns and descending `thread/turns/list` pages of ten turns;
large turns can produce multiple message pages. Older pages use opaque server
cursors bound to session, account, provider conversation and history generation.
Cursor storage has a 64 MiB budget and a 512-entry limit. Expired or evicted cursors
return 409; an individual continuation exceeding the budget returns 413.
Claude and OpenCode currently parse their native transcript/export before slicing
pages; browser transfer and rendering are bounded, but these providers still
have full-source read costs. Legacy Codex versions also retain the full-read
compatibility path.

Scrolling upward fetches `/api/sessions/:id/chat/history?cursor=…` and preserves
the viewport while prepending. Ordinary rolling-window updates retain messages
already displayed. If a burst replaces the entire live window without overlap,
the browser resets accumulated pages to the newest cursor so subsequent scrolling
loads contiguous history. A clear, native rebind or history generation change discards
previous history and cancels pending requests. Slow reads can return the saved
snapshot after 1.5 seconds, then publish completion including metadata-only
changes. Historical image grants are bounded, session-scoped and invalidated by
history generation changes.

## Verification

Coverage includes real WebSockets and native-file notifications, independent chat
and terminal upgrades, origin/authentication rejection, logout, reconnect,
ordered deltas, shared readers, close during an outstanding read, provider paging,
clear/rebind races, cursor budgets, historical images, browser scroll anchoring,
recovery, and Shift+Enter regression coverage in the terminal suite.

## Deferred scope

File explorer upload/download remains a separate future feature. This change does
not introduce a broker or require additional installed infrastructure. Incremental
Claude/OpenCode source parsing can further reduce native history read costs.
