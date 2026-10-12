# Host backups

Settings → Backups creates a host backup of the data directory and restores one into
a new, separate data directory. The running instance never switches its data
directory. `node scripts/operations.mjs backup|inspect|restore` offers the same
operations on the command line.

## What a backup holds

Always, as public (unencrypted) members:

- Accounts, provider connections, repositories, preferences, pipeline definitions,
  the port from `config.json`.
- Project memory and pipeline history as consistent SQLite snapshots (memory without
  capabilities), the audit log, pinned artifacts, the sanitized MCP server store.
- Agent data under `assistants/` without runtimes, package caches, update snapshots,
  TLS material and backup keys (see `docs/assistant-gateway.md`).

With **Include history**, also public:

- AgentPier session records and terminal captures, chat histories and AgentBus
  history.
- Each managed CLI profile's conversation history (table below). History can contain
  private task content; it is not encrypted.

With **Include encrypted credentials**, sealed in the passphrase capsule (AES-256-GCM,
scrypt-derived key):

- Each managed profile's `secret.json` (API key) and the allowlisted login and
  configuration files of its CLI (table below).
- Provider connection keys, repository credentials and MCP server values.

## CLI profile allowlists

A managed profile lives in `<data>/profiles/<account>/`; a provider profile keeps its
CLI folders below `providers/<provider>/`. Only the files named here are captured.
Anything else, including files and folders a CLI adds in a later version, is never
read, so caches, logs and telemetry cannot make a backup grow or fail.

| CLI                                             | Capsule (with credentials)                                                                                                                                                                                                                | History (with history)                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Codex (`codex/`)                                | `auth.json`, `config.toml`, `.credentials.json` (MCP OAuth file store), `AGENTS.md`, `AGENTS.override.md`, `prompts/`, `skills/` (without `.system/`), `agents/`, `commands/`, `rules/`                                                   | `sessions/`, `archived_sessions/`, `history.jsonl`, `session_index.jsonl`, `generated_images/`, `thread_history*.sqlite` snapshot |
| Claude Code (`claude/`)                         | `.claude.json`, `.credentials.json`, `settings.json`, `settings.local.json`, `CLAUDE.md`, `agents/`, `commands/`, `skills/`, `output-styles/`, `plugins/installed_plugins.json`, `plugins/known_marketplaces.json`, `plugins/config.json` | `projects/`, `todos/`, `file-history/`, `history.jsonl`                                                                           |
| OpenCode (`config/opencode/`, `data/opencode/`) | `opencode.json`, `opencode.jsonc`, `config.json`, `tui.json`, `tui.jsonc`, `AGENTS.md`, `agent(s)/`, `command(s)/`, `mode(s)/`, `skill(s)/`, `tool(s)/`, `plugin(s)/`; `data/opencode/auth.json`, `mcp-auth.json`                         | `data/opencode/storage/`, `data/opencode/opencode.db` snapshot                                                                    |

Inside allowed folders, `node_modules`, `cache`, `.cache`, `.git`, `log`, `logs`,
`tmp`, `.tmp`, `*.before-sharing*`, SQLite `-wal`/`-shm`/`-journal` files, `.lock`
and `.tmp` files are always skipped. Never captured at all: Codex `log/`,
`logs_*.sqlite`, `state_*.sqlite` (a projection Codex rebuilds from `sessions/`),
`cache/`, `shell_snapshots/`, plugin caches and `.tmp/marketplaces`; Claude Code
`debug/`, `statsig/`, `telemetry/`, `shell-snapshots/`, `plugins/cache/`,
`plugins/marketplaces/`; OpenCode `cache/`, `state/`, `data/opencode/log/` and
`snapshot/`; installed CLIs (`<data>/clis/`), agent runtimes and recovery data.

Plugins installed from a marketplace are recorded, not copied: Claude Code fetches
the marketplace again, and a plugin may need to be installed again after a restore.

Profiles of accounts that `accounts.json` no longer lists are not captured. Links
that sharing created are skipped as before; any other link, hard-linked or foreign
file in a profile is skipped and reported as an omission, never followed. The
capsule is sealed in memory: a profile whose capsule part exceeds 64 MiB, or all
profiles together beyond 160 MiB, fail the backup with the profile's name.

## Archive format

A backup is a `.apbackup` file. Version 2 is a
gzip-compressed POSIX tar that is written and read as a stream:

1. `agentpier-backup.json`, first: `{ format: "agentpier-backup", version: 2,
manifest, members }`. `manifest` holds `schemaVersion` 2, `applicationVersion`,
   `createdAt`, `withCredentials`, `includeHistory`, `consistency`, `omissions`,
   `captures` and the agent sealing record. `members` lists every following entry in
   archive order as `{ path, size, sha256, mode: 0o600, kind }`, `kind` being
   `public` or `credentials`.
2. `credentials.json` when the backup has credentials: the sealed capsule, always the
   first member.
3. Every public member as a regular file entry.

The header is a separate, uncompressed (stored) gzip member. It is written with
placeholder hashes first and rewritten in place once all members are streamed;
its length depends only on the member list, so the rewrite never moves data. A
multi-member gzip file is still an ordinary `.tar.gz` for standard tools.

Entries are ustar regular files with mode 0600. A name longer than 100 bytes or
outside printable ASCII is carried in a PAX `path` record; sizes of 8 GiB and more
use the GNU base-256 field.

### Reading

The reader accepts only what the writer produces and checks the header before it
writes anything:

- Format, version and schema must match; the header has exactly its four fields and
  each member exactly its five. Member paths are relative, without `..`, empty or
  control-character segments, unique, and never both a file and a folder.
- `withCredentials` must match the presence of the capsule.
- A restore checks every path against the public and credential allowlists
  (application files, agent data, the CLI history and capsule allowlists above).
- Entries must arrive in the declared order with the declared names and sizes. Only
  regular files (`0`) and PAX `path` headers (`x`) with mode 0600 are accepted:
  links, devices, folders, prefixes and other PAX records are rejected. Header
  checksums, padding and the end-of-archive marker are verified; trailing data,
  truncation, a missing or extra entry and a SHA-256 mismatch fail the read.
- Files are created with `O_EXCL` and mode 0600 below the staging folder of a new
  target; folders get mode 0700. The capsule is decrypted as soon as it is read, so
  a wrong passphrase fails before any history is extracted.

Version 1 archives (one gzip JSON document with base64 members, at most 256 MiB)
remain readable for inspection and restore. Earlier AgentPier versions reject a
version 2 archive without restoring anything: as "Invalid or oversized AgentPier
archive", or, above 256 MiB, as too large.

## Size, memory and disk space

There is no archive size limit and no per-component limit. Large files are streamed;
files up to 1 MiB are read while the backup is planned (64 MiB in total), so a file
replaced by its writer at that moment is still captured whole. A large file that
shrinks while it is archived fails the backup with its component's name; a file
that grows is captured up to its planned size.

Before writing, the backup checks that the backup folder's file system can hold the
uncompressed size of all members plus 64 MiB; restore and inspection check their
target the same way. History databases are first copied into a work folder below
`<data>/operations/`, which is also checked. Memory stays bounded independently of
the archive size (measured: about 80 MiB of additional RSS for a 4 GiB archive,
backup and restore alike).

Downloads stream the file with its length. Uploads stream into
`<data>/operations/restores/` and keep the archive only when its header is valid;
inspection and restore verify every member.

## Errors

Backup errors name the component they come from, for example
`Profile "Work" (Codex): A file changed during the backup. Create the backup again.`
or `Sessions: Contains a symbolic link and cannot be backed up.` Insufficient space
reports the required and available size.

## Restore

Restore writes a brand-new data directory: all members are extracted into a hidden
staging folder beside the target, validated (SQLite integrity and schema versions,
artifacts, agent sealing, project mappings) and renamed into place only when
everything succeeded. CLI histories return to the same profile folders. Claude Code
transcripts of a remapped project move to the folder Claude Code derives from the
new project directory. The restore report lists profiles that need a new login: a
profile counts as logged in when its API key or its CLI's login file
(`codex/auth.json`, `claude/.credentials.json`, `data/opencode/auth.json`) was
restored.
