# Mobile connection and upload recovery

AgentPier 1.5 adds recovery for terminal connections and unfinished uploads, plus
incremental chat responses. The existing [message delivery guarantees](mobile-delivery.md)
and [login requirements](login.md) still apply.

## Returning to the terminal

After the document becomes visible, a restored page appears, or the network comes
back, the browser replaces a potentially stale terminal socket. Nearby wake events
are combined. Obsolete socket callbacks cannot alter the current terminal; input
is never buffered or replayed. The terminal resends its fitted geometry when its
viewport has a positive size. Reconnecting continues with the existing backoff.

## Chat synchronization

`GET /api/sessions/:id/chat` returns the existing snapshot plus `sync` metadata.
Subsequent requests may send `?cursor=...`. Delta responses contain current metadata,
changed messages, removed IDs and an order list when order changes. They include
the exact base cursor the browser must hold. Invalid deltas cause a full read.

Cursors are opaque, temporary synchronization hints, never credentials. Every read
still checks the session and decorates images through the existing safe image path.
Account, session and native conversation identity scope the cursor. A server restart,
expired/unknown cursor or changed binding results in a full snapshot. Fingerprint
baselines are limited to 128 entries, eight per scope and a 4 MiB serialized
fingerprint budget, with a
two-minute inactivity lifetime; historical message bodies are not cached there.

This reduces repeated network transfer. The server still reads the native history
through its existing parser/cache and maintains its normal saved snapshot.

### WebSocket base cursors

The chat WebSocket accepts `?cursor=<id>` with the cursor the browser holds. The value
must match `^[A-Za-z0-9-]{1,64}$`; anything else is ignored and the first frame is a
full snapshot. The HTTP route and the socket share one `ChatSync` instance, so a
cursor issued by either transport is valid for the other (the socket-only
`nativeInput` field is normalized away before fingerprints are compared).

Baselines expire 30 minutes after their cursor was last issued, or reissued because
an unchanged snapshot reuses an existing cursor; using a cursor as a delta base does
not extend its lifetime. There are at most 512 entries and
16 MiB in total and eight active baselines per scope. When a socket closes, its last
issued cursor is parked: only cursors the server issued are parked, at most two per
scope and 256 in total, each for 30 minutes from the moment it was parked. Parked
baselines are evicted first under memory pressure and do not count against the
per-scope active limit. This lets a reconnecting browser, or one restoring a cached
chat, receive a delta instead of the full history. Deleting a session discards all of
its baselines, active and parked.

### Chat session cache in the browser

The browser keeps a bounded cache of recently opened chats so that reopening one shows
its messages immediately, before the socket has delivered anything.

- Memory layer: an LRU of 12 chats, keyed by `[session id, account, tool, createdAt]`.
- Device layer: IndexedDB database `agentpier.chat.cache.v1`, object store `sessions`,
  with at most 12 entries and 8,000,000 in total serialized size (least recently used first out).
  Entries are serialized only when the cache is flushed (throttled writes, page hide,
  and after the next paint on a session switch), not on every change. A flush writes
  its entries and the resulting evictions in one transaction; eviction is decided from
  an in-memory index of entry sizes and access times filled by the startup read. The
  same transaction lists the stored keys, forgets keys other tabs removed, and reads
  only the few entries other tabs wrote, so the bounds hold across tabs. Pruning
  removed sessions reads keys only and is skipped while the session list is unchanged.
  After the first device failure the cache stays memory-only.
- Invalidation: entries carry a cache version and the build identifier. An entry with
  a different version or build, an invalid shape, or one whose session was removed is
  dropped on load.

A restored chat is not live. It is shown with the stale label, without native input
warnings and without running subagents, and loading older history is disabled until
the first server frame has been accepted; then the cached window is replaced and the
scroll position is restored from its saved anchor (the first at least partly visible
top-level row). The startup read races the workspace state: a chat view mounted
before it settled adopts the cached entry when it arrives, as long as no server frame
was accepted yet; its socket, opened without a cursor, stays open and its first full
frame replaces the cached window. History is loaded after the restore. If the server
no longer knows a restored, non-live paging cursor (409 with the history mismatch
message), paging restarts from the live cursor and the restored older rows are
replaced together with that page instead of showing a history error; a pending or
unavailable history is reported as usual. A delta on a socket's first frame applies
to the baseline the socket was opened with, even if an HTTP fallback read replaced it
in between. "Connected" in the transport means the first frame was accepted: when the
socket opens, the state is "connecting" and only becomes "connected" after that
frame on the open socket. An HTTP fallback read updates the chat but leaves the state
as the socket reports it.

Clearing rules:

- Logout, or a session that is no longer authenticated, clears the whole cache.
- Another tab changing the login updates the `agentpier-auth-change` storage key. Each
  tab remembers the last seen login-change marker; a tab that notices a different
  marker, including right before a queued device write, clears its cache instead of
  writing stale entries.
- Removing a session forgets its entries and leaves a tombstone so a pending write
  cannot bring it back. Loading the session list prunes entries whose session is gone.
- Clearing also invalidates queued writes through a generation counter. It always
  reaches the device, even after earlier device failures; if the store cannot be
  cleared, the whole database is deleted as a fallback.

Intentionally kept across logout, because they are not chat history caches: message
drafts and the outbox (`localStorage`), pending uploads (IndexedDB `chat-upload-store`,
see below), and the browser's HTTP cache of immutable tool images.

## Slow connections

Chat snapshots are validated before use, on the socket and on the HTTP fallback. An
incomplete response shows a retry notice and keeps the previous chat instead of
replacing it.

If the first socket snapshot takes longer than 30 seconds, the HTTP fallback and a
socket reconnect compete for the same bandwidth. This is why chat payloads are kept
small: long tool output is capped and images are loaded on demand (see
[Tool output size](chat-observability.md#tool-output-size)).

API responses of 1 KiB or more are compressed with gzip, and chat WebSocket frames of
1 KiB or more with permessage-deflate. Attachment downloads, the MCP machine transport,
`/auth` and the terminal stream are not compressed.

## File uploads

Each selected file has its own progress, completion or error state. Successful files
remain attached when another upload fails. Failed files can be retried individually
or removed; unresolved files block message submission.

Pending file copies are stored in the browser's IndexedDB before transfer, under
the existing session/account scope. Reload restores interrupted files for explicit
retry and never starts an upload automatically. Completed server receipts are kept
with the pending copy until the existing completed attachment manifest is durable.
This lets a retry finish saving known successful uploads without uploading them again.

Limits remain eight attachments per message and 10 MiB per file. A retry restarts one
file, without byte-range resume. If the server accepted a file but its response was
lost before the browser saved the receipt, retrying may leave an unused server copy
subject to the existing storage limits. Browser storage deletion/quota failures can
prevent recovery and are reported. Pending copies belong to this browser and do not
move between devices. Tests use disposable sessions; physical iPhone suspension is
also worth checking after an update.
