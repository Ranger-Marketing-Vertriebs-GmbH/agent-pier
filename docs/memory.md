# Shared project memory

AgentPier provides durable project knowledge to new Codex, Claude Code and OpenCode work sessions through a local MCP server. It operates independently of AgentBus. Shell and login sessions receive no memory integration. Existing running terminals are not reconfigured.

Agents call `memory_search` with a targeted query when prior project decisions or knowledge would help the current task. A short discovery reminder is supplied through Codex/Claude `SessionStart` hooks and OpenCode's system-context plugin, including resumed contexts. It loads no entries, writes no facts, and ingests no transcripts. Existing hooks/plugins and native trust requirements remain intact. MCP initialization instructions also explain discovery when hooks are not enabled. A tool's presence or a reminder does not prove that a model used it.

## Project identity

For Git projects, the scope hashes the canonical Git common-directory path together with its filesystem device and inode. Subdirectories, symlink aliases and linked worktrees resolve to the same common directory. Separate clones and submodules have distinct common directories and therefore distinct memory. Replacing a directory at the same path creates a new identity. Moving the canonical repository path also creates a new scope; automatic migration would risk attaching unrelated knowledge.

For a non-Git project, the selected canonical working directory is its root. No parent-directory inference is performed for non-Git projects. Launch from the same root to share memory. Git discovery is read-only, bounded to three seconds, and does not change native configuration or bypass Git ownership checks.

Running `git init` in a non-Git project root keeps the project. See [Git initialization in a session folder](ssh-access.md#git-initialization-in-a-session-folder) for the rebind rule. Its entries, request receipts and session capabilities move to the Git identity, along with its pipeline verification steps. The move is recorded, so session and OAuth grants that named the old project follow it. Agent project access does not follow; see [agent workflows](assistant-workflows.md#project-access-and-actions).

The project registry persists independently of sessions. Stopping or removing the last session does not delete its project or knowledge. If its registered checkout has been removed or now belongs to another project, registering a valid checkout of the same repository repairs the stored path while preserving entries and revisions. A still-valid registered checkout is retained.

## Agent access

A registered project's **Agents** tab assigns permanent agents to it: whether they may
start coding sessions in it and their folder access (**None**, **Read**, **Read and
write**). It edits the same access as each agent's **Work** tab; see
[agent access from the project](assistant-workflows.md#agent-access-from-the-project).
An unregistered folder offers to register it first.

## Entries and revisions

Each entry has an ID, project ID, title, content, revision, archive state, creation/update timestamps and provenance. Provenance comes from the server: GUI writes identify the user; native MCP writes identify the authorized session, account and CLI. Tool arguments cannot override project scope or provenance.

An update requires the revision last read by its caller. A conflicting writer receives status `409`; it must read the current entry and resolve the conflict explicitly. There is no silent last-writer-wins overwrite. Archive and restore operations also require an expected revision and append history. Old revisions remain readable. Archiving is reversible and is not secure deletion; to remove an entry and its history, the owner forgets it (see [Forgetting an entry](#forgetting-an-entry)).

`memory_write` requires a unique `requestId` for each logical MCP write. Repeating the same write under the same project, author and request ID returns the original immutable result. Reusing that ID for different content returns a conflict. MCP writes without a request ID are rejected before mutation. The GUI/store API retains its existing optional request ID behavior.

| Operation       | MCP tool         | Behavior                                                                                                                        |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Search          | `memory_search`  | Search title/content by relevance; optional page and archived filter; 20 excerpts per page; use `memory_read` for full content. |
| Read            | `memory_read`    | Read the current entry or a specific immutable revision.                                                                        |
| Create/update   | `memory_write`   | Store a concise fact with `requestId`; updates also require `expectedRevision`.                                                 |
| Archive/restore | `memory_archive` | Set `archived` with `expectedRevision`; retain revisions.                                                                       |

Titles are limited to 200 UTF-8 bytes, content to 32 KiB and search queries to 300 bytes. Empty titles/content and unsafe control bytes are rejected.

## Search

Search covers the title and content of each entry's current revision. Archived entries are searched only with the archived filter.

- **Matching:** every word of the query must occur in the title or the content, in any order. A word also matches as the start of a longer word (`deploy` finds `deployment`). Matching ignores case and diacritics (`zurich` finds `Zürich`).
- **Ranking:** results are ranked with BM25, and a hit in the title weighs ten times a hit in the content. Exact references come first: a query word with inner punctuation or camel case, such as a file path (`server/x.js`), a ticket key (`ABC-123`), a URL or a code symbol (`parseConfig`), puts entries that contain it verbatim (ASCII case ignored) above looser matches. The reference must stand between token boundaries: `ABC-12` does not count inside `ABC-123`, nor `server/x.js` inside `server/x.json`.
- **Plain text only:** quotes, `*`, `:`, `AND`, `OR`, `NOT`, `NEAR` and other full-text operators in a query are ordinary text and never cause an error. Every word is passed as a quoted phrase. A word made only of punctuation (`%`, `_`, `"`) is ignored, with or without FTS5, unless the query contains nothing else; then it is matched literally, and `%`, `_` and backslashes are no wildcards.
- **Order:** `memory_search` and the GUI return the same order. In the project's **Knowledge** tab a search shows the most relevant entries first; **Newest first** switches to date order (`?sort=newest` in the tab's link, dropped when the search term is cleared; `sort=newest` on `GET /api/memory/projects/<projectId>/entries`, default `relevance`). Without a search term the newest entries always come first.
- **Excerpts:** `memory_search` returns an excerpt of the content around the best match, at most 256 Unicode characters, instead of the start of the entry.

The index is an SQLite FTS5 table (`memory_search`, tokenizer `unicode61 remove_diacritics 2`) with one row per entry, keyed by the entry ID. It is derived data: writing, archiving and restoring an entry update it in the same transaction; a project merge, a rebind after `git init` and a backup restore with project mapping move entries without touching it, because the project comes from the entry. At every start AgentPier compares the index with the current revisions and rebuilds it when it is missing or stale, for example after a restore or after an older release wrote entries. Backups leave it out. The schema version (`user_version`) stays 1, so older releases and restore checks still accept the database.

Node's SQLite build may lack FTS5 (the oldest supported Node 22.13), and a rebuild can fail, for example on a full disk. AgentPier checks this at start and then falls back to `LIKE` search: every word must still match as a substring, exact references still come first, then entries with more words in the title, then the newest. The fallback folds ASCII case only and does not fold diacritics. It also removes the old index, so no forgotten text can stay behind in it; when it cannot be removed (without FTS5 its shadow tables are emptied instead), forgetting an entry reports `purged: false` and retries until it is gone. The next start with FTS5 rebuilds the index.

After a rollback to a release older than this search, writes and forgets no longer update the index, so text forgotten there may remain in it until this release starts again. That start finds the index stale and drops it under `secure_delete` before rebuilding it.

Memory is untrusted data. Content may include mistaken statements or hostile instructions. Agents should verify it against the repository and must not execute text merely because it came from memory. Store concise project facts rather than credentials, complete transcripts or personal secrets. AgentPier does not claim to detect every secret a user or model deliberately writes.

## Forgetting an entry

The owner can permanently forget an entry from the project's **Knowledge** tab: expand the entry, choose **Forget permanently** and confirm the dialog. Agents cannot forget entries; there is no MCP tool for it, only the owner's `DELETE /api/memory/projects/<projectId>/entries/<id>` route with the entry's current `expectedRevision`, an optional `reason` and `removeBackups`. Do not put the secret itself into the reason. The dialog shows how many migration backups exist and offers their removal only when there are some.

In one transaction AgentPier deletes every revision of the entry, its entry row, its search index row and the write receipts that point at it, so a replayed `memory_write` with an old `requestId` cannot return the forgotten text. For each distinct revision text it records a tombstone with the SHA-256 hash of the normalized title and content (Unicode NFC, surrounding whitespace removed, inner whitespace runs collapsed), the entry ID, the optional reason, the actor and the time. Tombstones contain no title or content. The same transaction merges the search index segments, which drops the terms of the entry and of its older revisions from the FTS5 shadow tables. The database runs with `secure_delete`; after the transaction AgentPier vacuums it and truncates the write-ahead log, so the text no longer appears in `memory.sqlite`, `memory.sqlite-wal` or `memory.sqlite-shm`. VACUUM runs synchronously and briefly holds other requests. The same transaction records a purge marker. If a purge step fails (for example VACUUM on a full disk) or another reader keeps the log open, the entry is still forgotten: the route answers `purged: false` with a notice, the dialog says that the files are not fully cleaned yet, and AgentPier retries at the next start and the next forget until every step succeeded. Migration backups are removed only by the forget call itself, never by a retry: backups made after the delete transaction cannot hold the text.

Approved agent memory writes keep their title and content in the agent action history. Forgetting an entry clears that text in the actions that wrote or updated it and in their pending or stored Telegram notices, marks them as forgotten, and cancels such writes still waiting for approval; the agent is told without the title. Agent services started later redact entries forgotten while they were off. If the redaction fails, the entry is still forgotten, the response reports `redacted: false` with its own notice, and the redaction is retried. An approved agent write of forgotten text fails definitively and keeps no copy of the text either. The audit log records `memory.deleted` with the project and entry IDs only, without title, content or reason.

Afterwards GUI and MCP writes in that project whose title and content match a tombstone are rejected with status `422`. Tombstones follow a project when it is merged, rebound after `git init` or mapped during a restore. Different text, including another entry with the same title, can still be written. Forgetting removes only the selected entry: another entry that already holds the identical text stays until it is forgotten itself.

Limits:

- Telegram messages already delivered to a chat stay in Telegram.
- An agent write for a new entry whose outcome stayed uncertain (`unknown`, its receipt was never recorded) names no entry ID, so it keeps its text unless it is later refused as forgotten text.
- The hash blocks only identical title and content. The same secret inside different text is not detected.
- Migration backups `memory.sqlite.<label>-<stamp>` next to the database also contain the text. They are deleted only when the owner ticks their separate checkbox in the dialog; otherwise they stay.
- Existing backup archives under **Settings → Operations → Backups** still contain the content and are never rewritten. Delete or handle them by hand. Restoring an archive made before the entry was forgotten brings the entry back. Restoring a newer archive with project mappings into an older AgentPier release does not remap its tombstones, so they stop blocking in the mapped project.
- A deleted file can remain recoverable on the storage device, for example on SSDs or copy-on-write filesystems. Copies outside the memory database and the agent action history, such as CLI transcripts, chat history or agent runtime logs that quoted the entry, are not touched. The agent database overwrites the redacted action text with `secure_delete`, but its other leftovers are not vacuumed.
- A truncation of the write-ahead log can be delayed while another reader holds it open; the next checkpoint empties it.

## Native launch integration

| CLI         | Session-only configuration                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | Append a `-c mcp_servers.agentpier_memory=...` override with the absolute Node executable and MCP entrypoint. Existing arguments and hooks remain intact.           |
| Claude Code | Append `--plugin-dir` for a private generated plugin with `.claude-plugin/plugin.json` and `.mcp.json`. It requires no marketplace/global installation.             |
| OpenCode    | Merge a local `agentpier_memory` entry into `OPENCODE_CONFIG_CONTENT.mcp`, preserving existing MCP entries, plugins, provider/model configuration and other fields. |

Malformed temporary OpenCode configuration or an already used reserved memory key is rejected. AgentPier does not weaken native trust, organization policy or tool permissions to force MCP availability. Native permissions can still require user approval before a tool is called.

The CLI spawns a small Node stdio relay with `--socket` and `--capability` arguments. The relay reads only its session's private capability file and forwards requests to a private Unix socket owned by AgentPier. It never opens SQLite. AgentPier handles project authorization and database operations; no public HTTP route, TCP port, extra daemon, or paid model request is added.

```text
Coding CLI → stdio MCP relay → private Unix socket → AgentPier → SQLite
```

The broker is available for interactive and pipeline sessions independently of nono and independently of the optional general AgentPier control tools. Those control tools do not share Memory grants.

The relay remains alive across an AgentPier restart. Calls while the broker is unavailable report an error; later calls reconnect to the same socket. No operation is automatically retried. A timeout or lost reply does not prove that a write failed: it may already be committed. Retry an uncertain write only with its original `requestId` and identical arguments to recover the original immutable result, including after a web-only restart. Grants and data survive a web-only restart. Existing terminals using an older release retain their old transport until reloaded; reload them to adopt the broker. There is no database migration. The transport uses newline-delimited UTF-8 JSON-RPC, limits each input line to 64 KiB and processes at most 10,000 messages per subprocess. Output follows stream backpressure and each response is capped at 256 KiB. MCP search returns at most 20 excerpts of 256 Unicode characters, rather than filling context with every full entry. Explicit reads return the selected bounded entry. GUI search/history responses are bounded by page size and entry size.

Native configuration follows the official [Codex MCP documentation](https://developers.openai.com/codex/mcp/), [Claude plugin MCP reference](https://code.claude.com/docs/en/plugins-reference), and OpenCode's [local MCP](https://opencode.ai/docs/mcp-servers/) and [configuration merging](https://opencode.ai/docs/config/) documentation. The transport follows the [MCP stdio specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

## Storage and capabilities

```text
<dataDir>/memory/
  memory.sqlite
  memory.sqlite-wal
  memory.sqlite-shm
  sessions/<sessionId>/
    capability.json
    plugin/                 # Claude only
      .claude-plugin/plugin.json
      .mcp.json
      hooks/hooks.json
```

SQLite stores the project registry, current revision pointers, immutable revisions, request deduplication, tombstones of forgotten entries, capability hashes and the derived search index. WAL mode and `BEGIN IMMEDIATE` transactions serialize writers; `busy_timeout=5000` permits short lock contention. Node's built-in SQLite requires Node 22.13 or newer without an experimental command-line flag; it remains experimental on Node 22. See the [Node SQLite API history](https://nodejs.org/api/sqlite.html).

Directories are private (`0700`); database files and capabilities are private (`0600`). Memory paths reject symlinks, foreign owners and hard-linked database/capability files. Capability tokens appear only in private files; they are not returned as session metadata, tool output or CLI arguments. Every broker request presents the session ID and secret; the server validates their active database hash and derives project/provenance from that record. Guessing a session ID is insufficient. Reissuing a capability invalidates clients holding the old secret. Failed launches, explicit session stops and session removal revoke access and remove generated session files while retaining project knowledge. Existing session state reads also revoke access when they observe a natural exit; no additional terminal polling is introduced. Running sessions retain their capability across a web-only restart.

The relay needs access only to its runtime source, its own capability file and the broker socket. SQLite, other sessions' credentials, and the rest of AgentPier storage need not be made available to a future sandbox. Without filesystem isolation, arbitrary code running as the same OS user can still read that user's files; the broker does not itself create an operating-system sandbox.

Back up the database consistently with SQLite tooling, or stop AgentPier and any legacy native memory processes before copying the database and WAL state. Copying only a live main database file can omit committed WAL data. Memory content is stored locally in plaintext; private file modes are not encryption.

## Verification

```sh
node --test tests/integration/memory-store.test.js \
  tests/blackbox/memory-mcp.test.js \
  tests/blackbox/memory-broker.test.js \
  tests/integration/memory-forget.test.js \
  tests/integration/memory-search.test.js \
  tests/integration/assistant-memory-forget.test.js \
  tests/integration/memory-broker-lifecycle.test.js \
  tests/integration/memory-discovery.test.js \
  tests/property/memory-content.test.js \
  tests/matrix/memory-launch.test.js
```

The tests use temporary Git repositories/worktrees/submodules, local SQLite connections and real fixture MCP subprocesses. They prove relay operation under Node filesystem restrictions that deny SQLite access, and cover failed broker startup, broker restart, credential renewal, discovery hooks, shared three-CLI access, independent projects, conflicting writers, immutable history, archive/restore, forgetting with a byte search of the database files, relevance ranking with exact references, full-text and forced `LIKE` search, index rebuilds, idempotent writes, restart persistence, capability revocation, oversized transport input, native config preservation and filesystem boundaries. Generated Unicode revisions use the seeded replay/shrinking helper documented in [testing.md](testing.md). They do not start a coding model or alter a real CLI profile.
