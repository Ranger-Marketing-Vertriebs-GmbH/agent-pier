# Mobile recovery and incremental chat

The approved scope is terminal recovery after returning to the app, incremental
chat delivery, and individually recoverable file uploads. CI failures discovered
before implementation are fixed and published separately.

## Terminal

On returning from a hidden document, a persisted pageshow, or network recovery,
replace a potentially stale terminal connection. Coalesce overlapping wake events,
ignore callbacks from obsolete sockets, and resize only once the terminal has a
nonzero viewport. Preserve reconnect backoff, authentication, terminal clipboard
handling and native input guards. Never replay terminal input.

## Chat

Keep the existing authenticated GET route and decorated, private-path-free
snapshot. An optional opaque cursor permits a delta containing changed messages,
deleted IDs, ordering changes and current metadata. Keep a bounded in-memory
history of fingerprints rather than message bodies. Unknown or expired cursors,
server restarts and changed conversation bindings return a complete snapshot.
Cursors are scoped to session identity; they never confer authorization.

The browser applies a delta atomically only against its exact base cursor. A
malformed or mismatched delta triggers one full read. Hidden/aborted requests and
responses from before a conversation switch cannot overwrite current history.
Unchanged message objects and scroll intent remain stable. Legacy full responses
continue working. Receipt-based outgoing delivery remains independent.

## Uploads

Show progress and errors per file, retain successful attachments, and retry only
the selected failed file. Keep pending file blobs in origin-local IndexedDB,
scoped to session/account identity. After reload, interrupted files offer explicit
retry; do not automatically repeat a POST. Persist completed attachment metadata
before removing its pending blob. Storage failures are visible. Sending is blocked
while unresolved files remain; users can remove them to send the rest.

Use existing upload authorization and size/count limits. A retry restarts one
file, not an entire batch; byte-range resume is outside this scope. An upload whose
server response is lost may leave an unused server file under existing cleanup
limits. No dependencies, real-user test data, or changes to network login policy.

## Verification

Exercise wake-event coalescing, stale callbacks, cursor expiry/binding/reordering,
reload with a pending file, partial batch failure and individual retry. Run the
complete backend checks and Chromium/WebKit browser suites after integration.
Push verified main to both remotes and update the installed release using the
existing staged activation process. Real iPhone suspension remains a manual check.
