# Shared project memory

AgentPier provides durable project knowledge to new Codex, Claude Code and OpenCode work sessions through a local MCP server. It operates independently of AgentBus. Shell and login sessions receive no memory integration. Existing running terminals are not reconfigured.

Agents call `memory_search` with a targeted query when prior project decisions or knowledge would help the current task. A short discovery reminder is supplied through Codex/Claude `SessionStart` hooks and OpenCode's system-context plugin, including resumed contexts. It loads no entries, writes no facts, and ingests no transcripts. Existing hooks/plugins and native trust requirements remain intact. MCP initialization instructions also explain discovery when hooks are not enabled. A tool's presence or a reminder does not prove that a model used it.

## Project identity

For Git projects, the scope hashes the canonical Git common-directory path together with its filesystem device and inode. Subdirectories, symlink aliases and linked worktrees resolve to the same common directory. Separate clones and submodules have distinct common directories and therefore distinct memory. Replacing a directory at the same path creates a new identity. Moving the canonical repository path also creates a new scope; automatic migration would risk attaching unrelated knowledge.

For a non-Git project, the selected canonical working directory is its root. No parent-directory inference is performed for non-Git projects. Launch from the same root to share memory. Git discovery is read-only, bounded to three seconds, and does not change native configuration or bypass Git ownership checks.

The project registry persists independently of sessions. Stopping or removing the last session does not delete its project or knowledge.

## Entries and revisions

Each entry has an ID, project ID, title, content, revision, archive state, creation/update timestamps and provenance. Provenance comes from the server: GUI writes identify the user; native MCP writes identify the authorized session, account and CLI. Tool arguments cannot override project scope or provenance.

An update requires the revision last read by its caller. A conflicting writer receives status `409`; it must read the current entry and resolve the conflict explicitly. There is no silent last-writer-wins overwrite. Archive and restore operations also require an expected revision and append history. Old revisions remain readable. Archiving is reversible and is not secure deletion.

`memory_write` requires a unique `requestId` for each logical MCP write. Repeating the same write under the same project, author and request ID returns the original immutable result. Reusing that ID for different content returns a conflict. MCP writes without a request ID are rejected before mutation. The GUI/store API retains its existing optional request ID behavior.

| Operation       | MCP tool         | Behavior                                                                                                                   |
| --------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Search          | `memory_search`  | Search title/content; optional page and archived filter; 20 concise excerpts per page; use `memory_read` for full content. |
| Read            | `memory_read`    | Read the current entry or a specific immutable revision.                                                                   |
| Create/update   | `memory_write`   | Store a concise fact with `requestId`; updates also require `expectedRevision`.                                            |
| Archive/restore | `memory_archive` | Set `archived` with `expectedRevision`; retain revisions.                                                                  |

Titles are limited to 200 UTF-8 bytes, content to 32 KiB and search queries to 300 bytes. Empty titles/content and unsafe control bytes are rejected. Search treats `%`, `_` and backslashes literally. SQLite's default `LIKE` matching folds ASCII case; non-ASCII text is preserved but does not receive full linguistic case folding.

Memory is untrusted data. Content may include mistaken statements or hostile instructions. Agents should verify it against the repository and must not execute text merely because it came from memory. Store concise project facts rather than credentials, complete transcripts or personal secrets. AgentPier does not claim to detect every secret a user or model deliberately writes.

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

SQLite stores the project registry, current revision pointers, immutable revisions, request deduplication and capability hashes. WAL mode and `BEGIN IMMEDIATE` transactions serialize writers; `busy_timeout=5000` permits short lock contention. Node's built-in SQLite requires Node 22.13 or newer without an experimental command-line flag; it remains experimental on Node 22. See the [Node SQLite API history](https://nodejs.org/api/sqlite.html).

Directories are private (`0700`); database files and capabilities are private (`0600`). Memory paths reject symlinks, foreign owners and hard-linked database/capability files. Capability tokens appear only in private files; they are not returned as session metadata, tool output or CLI arguments. Every broker request presents the session ID and secret; the server validates their active database hash and derives project/provenance from that record. Guessing a session ID is insufficient. Reissuing a capability invalidates clients holding the old secret. Failed launches, explicit session stops and session removal revoke access and remove generated session files while retaining project knowledge. Existing session state reads also revoke access when they observe a natural exit; no additional terminal polling is introduced. Running sessions retain their capability across a web-only restart.

The relay needs access only to its runtime source, its own capability file and the broker socket. SQLite, other sessions' credentials, and the rest of AgentPier storage need not be made available to a future sandbox. Without filesystem isolation, arbitrary code running as the same OS user can still read that user's files; the broker does not itself create an operating-system sandbox.

Back up the database consistently with SQLite tooling, or stop AgentPier and any legacy native memory processes before copying the database and WAL state. Copying only a live main database file can omit committed WAL data. Memory content is stored locally in plaintext; private file modes are not encryption.

## Verification

```sh
node --test tests/integration/memory-store.test.js \
  tests/blackbox/memory-mcp.test.js \
  tests/blackbox/memory-broker.test.js \
  tests/integration/memory-broker-lifecycle.test.js \
  tests/integration/memory-discovery.test.js \
  tests/property/memory-content.test.js \
  tests/matrix/memory-launch.test.js
```

The tests use temporary Git repositories/worktrees/submodules, local SQLite connections and real fixture MCP subprocesses. They prove relay operation under Node filesystem restrictions that deny SQLite access, and cover failed broker startup, broker restart, credential renewal, discovery hooks, shared three-CLI access, independent projects, conflicting writers, immutable history, archive/restore, idempotent writes, restart persistence, capability revocation, oversized transport input, native config preservation and filesystem boundaries. Generated Unicode revisions use the seeded replay/shrinking helper documented in [testing.md](testing.md). They do not start a coding model or alter a real CLI profile.
