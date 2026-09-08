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
