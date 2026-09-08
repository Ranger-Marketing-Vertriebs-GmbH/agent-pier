# Shared project memory

AgentPier provides durable project knowledge to new Codex, Claude Code and OpenCode work sessions through a local MCP server. It operates independently of AgentBus. Shell and login sessions receive no memory integration. Existing running terminals are not reconfigured.

Agents must call `memory_search` to retrieve relevant knowledge. The MCP initialization instructions and tool descriptions explain discovery; there is no automatic prompt injection, transcript ingestion, filesystem indexing or hook that writes facts on the agent's behalf. A tool's presence does not prove that a particular model has used it.

## Project identity

For Git projects, the scope hashes the canonical Git common-directory path together with its filesystem device and inode. Subdirectories, symlink aliases and linked worktrees resolve to the same common directory. Separate clones and submodules have distinct common directories and therefore distinct memory. Replacing a directory at the same path creates a new identity. Moving the canonical repository path also creates a new scope; automatic migration would risk attaching unrelated knowledge.

For a non-Git project, the selected canonical working directory is its root. No parent-directory inference is performed for non-Git projects. Launch from the same root to share memory. Git discovery is read-only, bounded to three seconds, and does not change native configuration or bypass Git ownership checks.

The project registry persists independently of sessions. Stopping or removing the last session does not delete its project or knowledge.

## Entries and revisions

Each entry has an ID, project ID, title, content, revision, archive state, creation/update timestamps and provenance. Provenance comes from the server: GUI writes identify the user; native MCP writes identify the authorized session, account and CLI. Tool arguments cannot override project scope or provenance.

An update requires the revision last read by its caller. A conflicting writer receives status `409`; it must read the current entry and resolve the conflict explicitly. There is no silent last-writer-wins overwrite. Archive and restore operations also require an expected revision and append history. Old revisions remain readable. Archiving is reversible and is not secure deletion.

`memory_write` optionally accepts `requestId`. Repeating the same write under the same project, author and request ID returns the original immutable result. Reusing that ID for different content returns a conflict. New writes without a request ID are separate operations.

| Operation       | MCP tool         | Behavior                                                                                                                   |
| --------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Search          | `memory_search`  | Search title/content; optional page and archived filter; 20 concise excerpts per page; use `memory_read` for full content. |
| Read            | `memory_read`    | Read the current entry or a specific immutable revision.                                                                   |
| Create/update   | `memory_write`   | Store a concise fact; updates require `expectedRevision`.                                                                  |
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

The CLI spawns an independent Node process over stdio. It opens its own SQLite connection and continues when the AgentPier web process restarts. No daemon, network listener, paid model request or remote service is required. The transport uses newline-delimited UTF-8 JSON-RPC, limits each input line to 64 KiB and processes at most 10,000 messages per subprocess. Output follows stream backpressure and each response is capped at 256 KiB. MCP search returns at most 20 excerpts of 256 Unicode characters, rather than filling context with every full entry. Explicit reads return the selected bounded entry. GUI search/history responses are bounded by page size and entry size.

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
```

SQLite stores the project registry, current revision pointers, immutable revisions, request deduplication and capability hashes. WAL mode and `BEGIN IMMEDIATE` transactions serialize writers; `busy_timeout=5000` permits short lock contention. Node's built-in SQLite requires Node 22.13 or newer without an experimental command-line flag; it remains experimental on Node 22. See the [Node SQLite API history](https://nodejs.org/api/sqlite.html).

Directories are private (`0700`); database files and capabilities are private (`0600`). Memory paths reject symlinks, foreign owners and hard-linked database/capability files. Capability tokens appear only in private files; they are not returned as session metadata, tool output or CLI arguments. Each tool call revalidates its capability and active database record. Failed launches, explicit session stops and session removal revoke access and remove generated session files while retaining project knowledge. Existing session state reads also revoke access when they observe a natural exit; no additional terminal polling is introduced. Running sessions retain their capability across a web-only restart.

This is a protocol scope boundary, not an operating-system sandbox against the same local user. Coding tools already able to read arbitrary files as that user can bypass application abstractions. Native sandbox and account permissions remain relevant.

Back up the database consistently with SQLite tooling, or stop all web and native memory processes before copying the database and WAL state. Copying only a live main database file can omit committed WAL data. Memory content is stored locally in plaintext; private file modes are not encryption.

## Verification

```sh
node --test tests/integration/memory-store.test.js \
  tests/blackbox/memory-mcp.test.js \
  tests/property/memory-content.test.js \
  tests/matrix/memory-launch.test.js
```

The tests use temporary Git repositories/worktrees/submodules, local SQLite connections and real fixture MCP subprocesses. They cover shared three-CLI access, independent projects, conflicting writers, immutable history, archive/restore, idempotent writes, restart persistence, capability revocation, oversized transport input, native config preservation and filesystem boundaries. Generated Unicode revisions use the seeded replay/shrinking helper documented in [testing.md](testing.md). They do not start a coding model or alter a real CLI profile.
