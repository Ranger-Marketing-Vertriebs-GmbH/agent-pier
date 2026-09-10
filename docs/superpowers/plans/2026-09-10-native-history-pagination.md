# Native Claude and OpenCode history pagination

## Scope

The existing 50-message HTTP/WebSocket pages now read bounded native source ranges.
Full-history adapters remain available for explicit export/resume callers and
unsupported legacy OpenCode storage. Native files and databases are never migrated
or modified by the readers.

## Claude

A first view reads complete JSONL records backwards in 64 KiB blocks, displaying
at most 50 messages. Its metadata is marked stale until a background source-offset
index is ready. Orphan tool results cannot force this provisional reader to scan
the entire transcript.

The disposable, private SQLite index stores offsets and identifiers rather than
conversation bodies. Its first scan yields between 64 KiB blocks; subsequent
updates scan only appended bytes. A bounded metadata accumulator preserves earlier
tasks, token observations and subagent lifecycle state without retaining ordinary
conversation text. Index-ready events replace provisional cursors once, then
refresh the stream after incremental updates without clearing loaded history.
Indexed pages hydrate complete message fragment groups in first-occurrence order
and resolve their tool results even when those records are far apart.

Cursors capture source identity, size, byte anchors and index generation. They
survive append and reject detected replacement, truncation and clear/rebind.
The native JSONL format is assumed append-only between resets: arbitrary in-place
middle rewrites followed by append outside the checked anchors require a rebuild
and cannot be detected without rereading the entire source.

At most 16 source indexes remain open; eviction and service shutdown remove their
private temporary directories. Individual records/pages are limited to 64 MiB;
metadata journals are bounded at 8 MiB/4,096 records. Exhausting metadata bounds
preserves known state and marks it stale rather than silently erasing active tasks.

## OpenCode

Current classic SQLite storage uses read-only message/part keyset queries, scoped
to the selected account and exact project directory. A page reads at most 50 visible
rows, 200 native parts and 16 MiB; even one very large multipart answer can paginate
without being exported whole. Todos come from the current native todo table.

Active WAL databases require existing sidecars and use a read-only transaction.
Checkpointed databases without sidecars use an immutable read with source-version
and sidecar revalidation; this avoids SQLite creating WAL/SHM files. Cursor scope
includes native database/session identity and revert state. Cleared boundaries,
replaced databases and foreign projects are rejected.

The schema and export semantics were verified against installed OpenCode 1.18.30
and its official release-tag source. Unknown/pre-SQLite layouts retain the legacy
export compatibility path. V2-only `session_message` storage, which that version's
existing export reader does not hydrate, returns an explicit unsupported-history
error rather than appearing as an empty conversation.

## Verification

Disposable JSONL and SQLite fixtures compare paged output against full
normalization, including interleaved fragments, late tool results and large
multipart messages. Byte-count assertions verify bounded first reads and
incremental append indexing. Coverage includes cursor replay, concurrent WAL
writers, read-only file checks, metadata budgets, index cleanup and stream
generation changes, alongside the existing repository and browser suites.
