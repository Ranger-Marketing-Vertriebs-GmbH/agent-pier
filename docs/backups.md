# Host backups

Settings → Operations → Backups creates a host backup of the data directory and restores one into
a new, separate data directory. The running instance never switches its data
directory. `node scripts/operations.mjs backup|inspect|restore` offers the same
operations on the command line; `backup` without `--with-credentials` (and a
passphrase on stdin) leaves out all histories and private content.

## What a backup holds

Always, as public (unencrypted) members:

- Accounts, provider connections, repositories, preferences, pipeline definitions,
  the port from `config.json`.
- Project memory as a consistent SQLite snapshot (without capabilities), the audit
  log, pinned artifacts (with a tombstone for every other record, and no publish
  receipt of an unpinned one), the sanitized MCP server store.
- Agent configuration under `assistants/`: `settings.json`, the agents' home
  folder and, of OpenClaw's state folder, only an allowlist: `openclaw.json` and its
  copies (secrets sealed or left out, see below), `plugin-skills/`, `credentials/`
  (sealed or left out like other credentials) and each agent's `agents/<agent>/agent/`
  configuration files. Every other file or folder below `state/`, including what a
  later OpenClaw adds, is private content. Agent databases go in as configuration
  copies (see "Agent databases" below). A restore without private content brings
  back working agents with their settings, channels, team policy, reminders,
  access, schedules and shell approvals, and an empty history. Runtimes, package caches (in any spelling, such
  as Chromium's `Cache`, `Code Cache` and `GPUCache`), update snapshots, TLS
  material, backup keys and the agents' browser profiles are never public members
  (see `docs/assistant-gateway.md`).

With **Include history** and **Include encrypted credentials** together, the
histories and private content, always encrypted (see "Sealed history"):

- AgentPier's own: session records and terminal captures (`sessions/`), chat
  histories (`chat/`), AgentBus inbox history and earlier imported AgentBus history
  (`imported-history/agentbus/`). Only chat files a restore accepts are captured; a
  temporary file that a crashed writer left in `chat/` or in a credential folder is
  left out.
- Each managed CLI profile's conversation history (table below).
- Pipeline history (`pipeline-runs/runs.sqlite`): task prompts, stage verdicts and
  findings.
- Unpinned artifacts: their generation files, and their records and publish
  receipts as `artifacts/unpinned.json`, which a restore merges back into the
  artifact index in place of the tombstones.
- The agents' private content below `assistants/`: workspaces with the owner's
  chat attachments (`workspaces/<agent>/attachments/`, up to 1 GB per agent; the
  agent's Profile > Chat attachments > **Clear attachments** empties the folder),
  files agents shared with you (`shares/<agent>/`), OpenClaw's transcripts and
  session index (`state/agents/<agent>/sessions/`), its media (`state/media/`),
  its memory index (`state/memory/`), every other file below `state/` outside the
  allowlist above (such as `config-journal-fingerprint.key` and `migration/`), and
  the full copies of the agent databases.

#### Agent databases

Each agent database is split: a public configuration copy keeps the schema and the
rows of its configuration tables; the full copy (credential tables emptied as
before) is sealed as `assistant-history/<path below assistants/>`, and a restore
with the passphrase puts it in place of the configuration copy. Credential rows in
either copy travel only in the sealed sidecar, exactly as without this split.

- AgentPier's `assistants.sqlite` and `channels.sqlite` lose their private rows:
  conversations, requests and attempts, cached messages, attachment and share
  indexes, queued messages, routine results and events, memory notes, action
  history, team records other than policy and settings, and Telegram inbox, outbox
  and unknown senders. `web-search.sqlite` and `pdf-model.sqlite` hold only configuration.
- OpenClaw's databases below `state/` (the global `state/state/openclaw.sqlite`,
  each agent's `agents/<agent>/agent/openclaw-agent.sqlite` and any other) keep the
  rows of an allowlist only: `agent_databases`, `agent_provenance`,
  `auth_profile_state`, `auth_profile_store`, `channel_pairing_allow_entries`,
  `claw_installs`, `claw_mcp_server_refs`, `claw_package_refs`,
  `config_health_entries`, `config_machine_state`, `config_revision_keys`,
  `cron_jobs`, `device_auth_tokens`, `device_bootstrap_tokens`,
  `device_identities`, `device_pairing_paired`, `exec_approvals_config`,
  `gateway_origin_device_tokens`, `mcp_oauth_pending_authorizations`,
  `mcp_oauth_stores` (always emptied), `migration_runs`, `migration_sources`,
  `operator_approvals`, `plugin_binding_approvals`, `plugin_state_entries`,
  `projects`, `schema_meta`, `secret_store_entries`, `user_preferences`,
  `web_push_subscriptions`, `worker_environment_credentials`,
  `worker_environments`, `workspace_setup_state` and `worktree_templates`. Every
  other table, including any a later OpenClaw adds, is emptied: sessions,
  transcripts, conversations, task, flow and subagent runs, delivery queues, audit
  and diagnostic events, memory and full-text indexes. A full-text or vector index
  is emptied through its module; one whose module this host lacks loses the rows of
  its shadow tables.
- Databases in a private folder (`state/memory/`, transcripts) are private as a
  whole. OpenClaw's lock and writer databases (`*-lock.sqlite`,
  `*.generation-writer.sqlite`) and its `state/locks/` and `state/tmp/` folders are
  runtime state and never captured; a restore still accepts them from older backups.

Histories hold task content and tool output verbatim, and Claude Code's
`file-history/` holds copies of edited files, so they are never archived in plain
text, and neither is private content. Without a passphrase, both are left out: the
backup dialog says so and how to back them up encrypted, and the plan and manifest
list "AgentPier and CLI histories are only backed up in backups with a passphrase,
and then encrypted" and "Agent chats, channel messages, workspaces and attachments,
pipeline history and unpinned artifacts are only backed up in backups with a
passphrase, and then encrypted". Without **Include history**, they list "AgentPier
and CLI histories" and "Agent chats, channel messages, workspaces and attachments,
pipeline history and unpinned artifacts"; the restore report repeats these
omissions. The
manifest's and the backup list's `includeHistory` says whether the backup holds
history, so it is false for a backup without a passphrase; in earlier backups it
recorded the choice, which then also meant public AgentPier history.

Earlier backups archived AgentPier's own histories as public
members whenever history was included, and agent chats, channels, workspaces and
attachments, pipeline history and (with history) unpinned artifacts always;
restore still accepts them, in version 1 and version 2 archives. Their manifests name "CLI conversation histories" and "CLI
histories are only backed up in backups with a passphrase, and then encrypted"
instead.

With **Include encrypted credentials**, sealed in the passphrase capsule (AES-256-GCM,
scrypt-derived key):

- Each managed profile's `secret.json` (API key) and the allowlisted login and
  configuration files of its CLI (table below).
- Provider connection keys, repository credentials and MCP server values.

The agents' own browser profiles (`assistants/state/browser/agent-<id>/user-data`)
hold their logins and cookies. They are archived only with **Include encrypted
credentials**, sealed like histories (see "Sealed history"), with or without
**Include history**, and never with their caches, crash reports or Chromium's
`Singleton*` links. A database the running browser holds is copied consistently; a
file it keeps locked is left out and the manifest lists "Agent browser files that
were in use". Only profiles of agents that still exist (archived ones included) are
archived; member slots and OpenClaw's default profile never are. Without a
passphrase the plan and manifest list "Agent browser profiles (only in backups with a
passphrase, then encrypted)"; every plan with agents lists "Agent browser caches" as
left out. Backups from before this change archived OpenClaw's default profile
publicly, caches included: a restore brings the profile back, leaves the caches out
and reports their number as `cachesLeftOut`.

## CLI profile allowlists

A managed profile lives in `<data>/profiles/<account>/`; a provider profile keeps its
CLI folders below `providers/<provider>/`. Only the files named here are captured.
Anything else, including files and folders a CLI adds in a later version, is never
read, so caches, logs and telemetry cannot make a backup grow or fail.

| CLI                                             | Capsule (with credentials)                                                                                                                                                                                                                          | History (sealed; with history and credentials)                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Codex (`codex/`)                                | `auth.json`, `config.toml`, `.credentials.json` (MCP OAuth file store), `AGENTS.md`, `AGENTS.override.md`, `prompts/`, `skills/` (without `.system/`), `agents/`, `commands/`, `rules/`                                                             | `sessions/`, `archived_sessions/`, `history.jsonl`, `session_index.jsonl`, `generated_images/`, `thread_history*.sqlite` snapshot |
| Claude Code (`claude/`)                         | `.claude.json`, `.credentials.json`, `settings.json`, `settings.local.json`, `CLAUDE.md`, `agents/`, `commands/`, `skills/`, `output-styles/`, `hooks/`, `plugins/installed_plugins.json`, `plugins/known_marketplaces.json`, `plugins/config.json` | `projects/`, `todos/`, `file-history/`, `history.jsonl`                                                                           |
| OpenCode (`config/opencode/`, `data/opencode/`) | `opencode.json`, `opencode.jsonc`, `config.json`, `tui.json`, `tui.jsonc`, `AGENTS.md`, `agent(s)/`, `command(s)/`, `mode(s)/`, `skill(s)/`, `tool(s)/`, `plugin(s)/`; `data/opencode/auth.json`, `mcp-auth.json`                                   | `data/opencode/storage/`, `data/opencode/opencode.db` snapshot                                                                    |

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

Restored files always get mode 0600, so hook and status-line scripts lose their
executable bit and need `chmod +x` again. `.claude.json` can hold per-project
prompt history of older Claude Code versions; it stays in the encrypted capsule and
is part of a credential backup even without history.

## Archive format

A backup is a `.apbackup` file. Version 2 is a
gzip-compressed POSIX tar that is written and read as a stream:

1. `agentpier-backup.json`, first: `{ format: "agentpier-backup", version: 2,
manifest, members }`. `manifest` holds `schemaVersion` 2, `applicationVersion`,
   `createdAt`, `withCredentials`, `includeHistory`, `consistency`, `omissions`,
   `captures` and the agent sealing record. `members` lists every following entry in
   archive order as `{ path, size, sha256, mode: 0o600, kind }`, `kind` being
   `public`, `credentials` or `sealed`.
2. `credentials.json` when the backup has credentials: the sealed capsule, always the
   first member.
3. Every public member as a regular file entry, and every sealed history file as an
   entry named `sealed/<n>`.

<a id="sealed-cli-history"></a>

### Sealed history

AgentPier's own histories, CLI histories, private content and the agents' browser
profiles are sealed the same way, in one sequence of `sealed/<n>` entries under one
key. A backup with browser profiles has a seal record even without history, so
AgentPier 2.0 to 2.2 cannot restore it.

The seal record (`history-seal.json`) has version 3 since private content is
sealed. Version 1 records (AgentPier 2.0 to 2.2) may only name CLI history paths
and may stand beside public AgentPier history; beside a version 2 or 3 record, a
public `sessions/`, `chat/` or `imported-history/` member fails the restore.
Version 2 records may not name private content, which may stand beside them in
public; beside a version 3 record, a public `pipeline-runs/runs.sqlite`,
`artifacts/unpinned.json`, `assistant-history/` member or agent workspace,
shared file, transcript, media or memory index member fails the restore. A record
version newer than the reader knows is reported as written by a newer AgentPier
version: AgentPier versions that know version 2 say so for a version 3 record. AgentPier 2.0 to 2.2 know only version 1 and report a
backup with a version 2 record as damaged or altered ("An encrypted CLI history in
the backup is damaged or was altered"); it needs a current AgentPier to restore.
Backups without history have no seal record and stay restorable there.

A backup with history draws a random 256-bit key. The capsule holds, as
`history-seal.json`, that key, the backup id and which `sealed/<n>` entry is which
history file; the archive itself shows neither the history's paths nor its content,
only ciphertext sizes (plaintext plus 16 bytes per MiB) and ciphertext hashes.
Database captures of sealed history are listed only as `cli-history-database`, and
AgentPier's own history captures as one `agentpier-histories` entry.

Each file is split into 1 MiB chunks, each encrypted with AES-256-GCM. The nonce is
the entry number and the chunk index; the additional data binds the backup id, the
history file's path, the chunk index and whether it is the last chunk. A changed
byte, a chunk moved, reordered or dropped from the end, an entry restored as
another file, or an entry under another key fails authentication. A restore opens
each chunk only after its tag verified and writes only authenticated plaintext into
the hidden stage; any failure aborts the restore, and nothing reaches the target.
An entry the capsule does not list fails the restore; a listed one missing from the
archive was removed while the backup ran. Inspection opens the capsule with the
passphrase but reads no history.

What the archive still shows of sealed history: how many history files there are
and each file's size to within 16 bytes per MiB. While the backup runs, the
plaintext copies of CLI history databases sit in the owner-only (0700) work folder
as 0600 files; each is removed as soon as it is sealed into the archive, the folder
when the backup ends, and after a crash at the next server start.

Every file a restore writes, whatever kind of member it comes from, is checked by
one guard: its path must be a clean relative path that resolves inside the real
path of the hidden stage, with no link or file on the way. Sealed history paths
from the capsule must also be history paths of the record's version (AgentPier's
session, chat and AgentBus history files, CLI history paths, browser profiles, and
with version 3 the private content paths above), each at most once and never the
path of a public member.

The header is a separate, uncompressed (stored) gzip member. It is written with
placeholder hashes first and rewritten in place once all members are streamed. Its
JSON is padded with spaces to a length reserved up front, with room for members
that are dropped and sizes that change while streaming, so the rewrite never moves
data. A multi-member gzip file is still an ordinary `.tar.gz` for standard tools.

Members an inspection validates (application data, databases, artifacts, agent
configuration) come right after the capsule; sealed history and other agent files
follow.

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

There is no archive size limit and no per-component limit; agent data and agent
workspaces stream like everything else.

Files are planned (listed and sized) first and opened only when they are archived.
Files up to 1 MiB are read while planning (64 MiB in total), so a file a writer
replaces at that moment is captured whole. A larger file is archived at the size it
has when it is opened, through that open descriptor, so a later rename or deletion
does not matter. A file that is gone by then is left out ("Files removed while the
backup was written"). After reading a file, the backup compares its size and
modification and change times with those at opening. A file that shrank or was
written to meanwhile ("Files that changed while the backup was written") is named
in the manifest's `captures` with `consistency: "changed-during-read"`; if it was
truncated during the read, the rest of its entry is filled with blank lines. A
restore keeps such files only when they are line-based (`.jsonl`, `.screen`), whose
archived prefix stays valid, leaves out any other (images, JSON, workspace files)
and lists those in the restore report. Database copies are private snapshots and
never change. Neither case fails the backup.

Before writing, the backup checks that the backup folder's file system can hold the
uncompressed size of all members plus 64 MiB; restore and inspection check their
target the same way. Database snapshots go to a work folder below
`<data>/operations/`, which is also checked. CLI history databases are copied after
the application snapshot, in a worker thread: copying a 533 MiB database blocked
the server's event loop for 682 ms before and 2 ms now.

Memory does not grow with the size of the files in the archive. Measured additional
RSS: about 80 MiB (backup) and 90 MiB (restore) for a 4 GiB history archive, and
about 80 MiB (backup) and under 50 MiB (restore) for a 416 MiB archive with a
160 MiB agent workspace. What is held
in memory: files up to 1 MiB within the 64 MiB planning budget, rewritten agent
configuration and sealed agent credentials, the member list, and the credential
capsule (up to 160 MiB of plaintext plus its encrypted and base64 copies) while it is
sealed or opened.

Downloads stream the file with its length. The browser uploads an archive in slices
of at most 16 MiB (the server accepts up to 64 MiB), each appended at an exact
offset into `<data>/operations/restores/`: no request comes near Node's request
timeout, and a failed slice is resent from the server's offset; the same upload
resumes from the server's copy, also after a server restart. Free space for the
whole archive, plus what other pending uploads still need, is checked when the
upload starts; an upload without a new slice for 24 hours is removed. A completed
upload is kept as `<id>.apbackup` for inspection and restore: a successful restore
removes it at once, a failed one keeps it for another attempt, and one unused for
24 hours (since its upload or its last inspection or restore) is removed. The
server checks both at its start and with every upload request. When the server no
longer has an upload or archive, the dialog uploads the chosen file again. A one-request upload (`POST /restore/upload`) needs its
`Content-Length` and is cut off beyond it. Only an archive with a valid format
header is kept. An inspection reads up to the last member it validates; a restore
reads and verifies every member.

## Errors

Backup errors name the component they come from, for example
`Profile "Work" (Codex): A file is not a regular, owned file and cannot be backed
up.` or `Sessions: Contains a symbolic link and cannot be backed up.` Insufficient
space reports the required and available size. Two members, public or sealed CLI
history, that differ only in letter case or Unicode normalization (possible in a
backup from Linux) are both restored on a file system that tells them apart. On a
file system that ignores the difference, such as APFS, they cannot both be
restored; the restore stops with a message that says so.

## Restore

Restore writes a brand-new data directory: all members are extracted into a hidden
staging folder beside the target, validated (SQLite integrity and schema versions,
artifacts, agent sealing, project mappings) and renamed into place only when
everything succeeded. CLI histories return to the same profile folders. Claude Code
transcripts of a remapped project move to the folder Claude Code derives from the
new project directory. Preferences come back as saved, except that the default
project folder follows its project mapping (and is dropped when the project is not
mapped) and default accounts the restored profiles cannot serve are cleared. Newer
Claude Code versions shorten long folder names with a
hash suffix; those folders are not moved. Other settings keyed by a project path
keep the old path: `.claude.json` `projects` entries (trust, project MCP servers),
Codex `config.toml` `[projects."<path>"]` and the `cwd` recorded in Codex rollouts.
Snapshot folders, unfinished archives, uploads, inspection folders and restore
stages are claimed by the process working on them (`operations/work/`: target,
process id, start time). Only the server removes such work, once when it starts,
and only when the claiming process is gone (its start time is read with `ps`, or
from `/proc` on Linux) or the claim is older than seven days: running
`scripts/operations.mjs` against the live data directory never disturbs an upload or
restore of the server. A chunked upload with a valid description is never removed
by that sweep: it stays resumable until it expires as above. Claims and the sweep
cover only backup work: `.snapshot-*`
folders in `operations/`, `*.tmp` archives in `operations/backups/`, uploads and
`.inspect-*` folders in `operations/restores/`, and `.agentpier-restore-<uuid>`
stages. A restore stage left by a crash is removed at the next server start. The restore report lists profiles that need a new login: a
profile counts as logged in when its API key or its CLI's login file
(`codex/auth.json`, `claude/.credentials.json`, `data/opencode/auth.json`) was
restored.
