# Chat events and lazy history

## Goal

Replace browser polling of `/sessions/:id/chat` with a reconnectable chat event
channel. A long native transcript must not block the first paint, and older
messages must be fetched only when the user scrolls upward.

## Design

1. Add a session-scoped `ChatEvents` service. It keeps a bounded sequence and
   subscribers, publishes only metadata (`snapshot changed`, `native binding
changed`, `session ended`) and never carries unbounded transcript content.
2. Add an authenticated WebSocket endpoint at
   `/api/sessions/:id/chat-stream`, reusing the terminal socket's origin,
   login, heartbeat, backpressure and shutdown rules. The first server message
   is a bounded HTTP-equivalent snapshot with a sequence number. Subsequent
   messages are invalidation events.
3. Keep the HTTP endpoint as the authoritative recovery path. On reconnect or
   a sequence gap the browser requests a full snapshot and resumes the stream.
4. Make native binding updates publish an event. Codex/Claude hooks and the
   process resolver therefore make `/clear`, resume and account changes visible
   without a browser poll.
5. Add a bounded history endpoint accepting a provider-specific cursor. The
   initial snapshot contains the newest 500 messages; scrolling near the top
   requests an older page and prepends it while preserving the viewport.
6. Keep a slow-history fallback: the saved snapshot is returned immediately,
   while a live refresh can publish a later invalidation. This remains useful
   when the provider app-server is unavailable.

## Delivery order

- Introduce the event service and lifecycle wiring with unit tests.
- Add and test the authenticated WebSocket protocol and reconnect behavior.
- Emit events from binding/chat snapshot changes and switch the controller to
  WebSocket-first with HTTP fallback.
- Add provider history cursors and viewport-triggered older-page loading.
- Remove the normal polling loop after browser coverage proves reconnect,
  sequence gaps, `/clear`, long transcripts and stopped sessions.

## Compatibility and limits

The endpoint is additive and existing HTTP clients continue to work. Events
are hints, not durable transcript storage; a reconnect always reconciles over
HTTP. The server must bound event queues and close slow clients. Provider
history remains read-only and never resumes a native conversation.

## Verification

Cover event ordering and bounded queues, WebSocket authentication and close
behavior, reconnect after a sequence gap, `/clear` binding changes, long
history fallback, prepend-on-scroll, and the existing terminal/browser suites.
