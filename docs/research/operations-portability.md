# AgentPier operations and portability

The implementation uses AgentPier's own account, memory, pipeline, terminal and service boundaries. The supplied AgentRunner source was reviewed read-only; its Docker checks, secret-store format and newest-two release pruning were not copied.

## Storage and consistency

Backups are versioned `.apbackup` gzip/JSON archives with explicit regular-file members, SHA-256 content checksums, capture metadata and omissions. They are bounded to 256 MiB compressed/expanded JSON, 20,000 members and a bounded encrypted credential capsule. They are private data, including task/history content; “credentials excluded” does not mean arbitrary user text is universally redacted.

The application mutation barrier drains application writes and pipeline transitions before synchronous metadata/SQLite capture. Encryption and compression follow after releasing it. Independent native processes continue running. Each SQLite database is a transactional `VACUUM INTO` snapshot; history files are captured prefixes at recorded times. There is no claim of one globally atomic snapshot across independent native writers. SQLite documents this distinction: [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html).

Included application components are accounts, repository metadata, preferences, pipeline definitions, memory revisions, pipeline execution history and audit events. Optional history includes cached Chat, saved terminal/event files and AgentBus inbox history. Existing imported AgentBus history is retained by subsequent backups.

The memory snapshot is sanitized before publication: capability rows and their token hashes are removed from the temporary copy and vacuumed. The live database and live capability files remain unchanged. Runtime request channels, native binding hooks, GitHub session credentials, push subscriptions/VAPID data, sockets, process identities, platform binaries, external local CLI profiles, keychains and repository worktrees are excluded.

`withCredentials:true` adds managed profile files and repository credential files inside a scrypt/AES-256-GCM capsule. The fixed parameters are N=32768, r=8, p=1, a 16-byte random salt, a 12-byte random nonce and a 16-byte authentication tag. The envelope header is authenticated; unsupported parameters are rejected before allocating a key derivation. Passphrases have 12–4096 characters and never enter argv, job records, audit or URLs. Node provides the required primitives without another native addon: [Node crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html).

Managed caches, node_modules, lock files and SQLite WAL sidecars are excluded from the capsule; recognized native SQLite files use SQLite snapshots. Linked files are refused instead of being followed outside a managed profile. Credentials stored in an OS keychain may still require a fresh login. Native configuration is private and may contain user-managed absolute paths; generated provider paths are regenerated at the next supported launch.

## Restore contract

Restore validates the archive, member paths, duplicate/file-directory collisions, checksums, schema metadata, embedded SQLite schema versions and integrity, project mapping, and credential authentication before publishing a destination. It creates a private sibling staging directory, then renames into an absent target. The target parent must already exist and belong to the current user; its permissions are not changed. The current data directory and its descendants are refused.

Memory project identity contains canonical path, Git common directory and device/inode. A project mapping is an object from the old memory project ID to an existing absolute target directory. Restore recomputes identity and updates project/entry/request references plus pipeline verification configuration. Mapping collisions are refused; all revisions and provenance are preserved. Unmapped projects remain historical records until deliberately mapped, rather than being silently attached to an unrelated checkout.

Imported sessions carry `imported:{originalStatus,restoredAt,historyOnly:true}` and are stopped with native runtime metadata removed. Imported unfinished runs become cancelled, retain original status in `imported`, and lose workspace ownership, active turns, verification jobs, scheduled quota resumes and pending recovery effects. They cannot launch, push, create PRs, read arbitrary worktree files or authorize cleanup. Historical deletion is separate from workspace deletion.

Audit import validates records, preserves IDs/timestamps, and writes transactionally into the empty target audit store. AgentBus messages are placed under `imported-history/agentbus`, with no runtime launches or peers. They are accessible read-only through `/api/operations/imported-history/agentbus` and the per-project endpoint; pending-at-backup messages are never delivered again.

The restore report lists account/repository credential IDs needing login, project mappings and omissions. Repository content and uncommitted files need a separate project transfer. Native CLI histories copied inside an encrypted profile are retained as files, but migration does not claim native resume compatibility across changed paths or CLI versions.

## MacBook to another Mac or Linux host

1. Export an archive; optionally include encrypted managed credentials/configuration.
2. Transfer or clone project repositories separately. Preserve uncommitted work separately; a Git clone alone does not transfer it.
3. Install the target platform release and tools. Inspect the archive, map old project IDs to target directories, then restore into a new data directory.
4. Use the new directory for the target service. Reauthenticate local/Keychain-backed native accounts, reinstall missing CLI binaries, and enable notifications on each target browser again.
5. Configure remote access for the target host separately. No source Tailscale identity, Serve configuration or machine-specific owner URL is overwritten by restore.
6. Start new sessions explicitly. Source native sessions keep running; processes and tmux sockets do not migrate between machines.

## Release implementation

Releases are immutable under `installRoot/releases/<version>`. `current` is an atomically replaced relative symlink; `bin/agentpier` is a stable launcher which defaults to the configured external data directory. Service definitions invoke the stable launcher. Linux retains `KillMode=process`; macOS uses the existing AgentPier LaunchAgent label. Neither update nor rollback deliberately stops native sessions.

The real package builder uses a pinned official Node 22.22.2 platform runtime verified against Node's SHASUMS256, installs production dependencies in private staging under that runtime, builds a bounded `.aprelease`, deletes source staging and performs a relocated native/runtime smoke. Copying this development machine's `process.execPath` alone failed because it requires a sibling libnode dylib; the official self-contained runtime resolves that evidenced portability problem.

Each release contains built `dist`, server/vendor/scripts, production modules and `bin/node`. Four platform artifacts are produced: darwin/linux × arm64/x64. GitHub runner labels are documented by [GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Tagged workflows publish matching version artifacts and `latest.json`; manual dispatch creates downloadable workflow artifacts only.

The release channel must use HTTPS. Bounded HTTPS redirects support GitHub release asset delivery; HTTP downgrade, invalid platform/version, oversized download, checksum mismatch, archive links/traversal and bad layout/runtime fail before activation. SHA-256 verifies integrity against the configured channel. It is not an independently pinned publisher signature; control of the channel controls the release contents.

Activation uses a detached helper with a durable job and heartbeat. It switches the pointer, restarts only the web service, and verifies the application/version plus a changed process instance ID. Failed health restores the previous pointer and restarts it, unless current data became incompatible with that previous version; in that case new data is preserved and recovery is explicit. Supported schema ranges are checked against persisted SQLite user versions; rollback never copies old databases over new writes.

All old releases are retained. Running sessions can invoke absolute old-release hooks/MCP helpers long after the web service updates, so an arbitrary newest-two pruning policy would break them. Release cleanup is deliberately not automatic.

## Installer and exact commands

From a clean source checkout, the installer does not require `npm ci`. It can bootstrap a verified private temporary Node runtime when a suitable Node is absent. `curl`, `tar` and a SHA-256 utility are bootstrap prerequisites. On macOS automatic dependency setup uses an existing Homebrew installation; on Linux it supports apt with noninteractive sudo permission. Other package managers can install tmux/Git first, then run the installer without `--install-dependencies`.

```sh
sh scripts/install.sh \
  --archive /absolute/path/agentpier-darwin-arm64.aprelease \
  --install-root "$HOME/.local/share/agentpier-app" \
  --data-dir "$HOME/Library/Application Support/AgentPier" \
  --install-dependencies \
  --service
```

`--install-dependencies` explicitly permits missing host tmux/Git installation; `--service` explicitly installs/restarts the user service. Omitting them checks prerequisites and installs only the owned release layout. For Linux choose the matching artifact and a stable data path such as `$HOME/.local/share/agentpier-data`. Never point the data directory inside a release directory. No private username or machine address is built into the installer.

Manual start uses `"$HOME/.local/share/agentpier-app/bin/agentpier"`. Existing source-checkout installation remains `npm ci`, `npm run build`, `npm start`, followed by optional `npm run service:install`. A versioned install is required for activation; the Settings UI reports this accurately while source checkouts can still create backups and run diagnostics.

Build a release on its target OS/architecture:

```sh
npm run build
node scripts/release-package.mjs /absolute/output/agentpier-darwin-arm64.aprelease
```

Versioned installations use the [official GitHub releases](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases) by default. Set `AGENTPIER_INSTALL_ROOT` and `AGENTPIER_DATA_DIR` before service installation; `AGENTPIER_RELEASE_CHANNEL` optionally overrides the default HTTPS channel. Checks and staging happen only on explicit request. Downloads use the reviewed release's version tag and checksum. Older versions are not offered as updates; use the separate rollback action to return to a compatible installed version.

```sh
node scripts/operations.mjs doctor --deep
node scripts/operations.mjs backup --with-credentials --passphrase-stdin
node scripts/operations.mjs inspect --archive /absolute/backup.apbackup
node scripts/operations.mjs restore --archive /absolute/backup.apbackup \
  --target /absolute/fresh-data --project-map /absolute/project-map.json \
  --passphrase-stdin
node scripts/operations.mjs release-check
node scripts/operations.mjs release-stage --version 1.1.0
node scripts/operations.mjs release-activate --staged-id STAGED_ID
node scripts/operations.mjs release-rollback --version 1.0.0
```

Passphrase-stdin consumes one bounded line; supply it through a password manager or private stdin, not a literal secret in shell history. CLI operation failures exit nonzero. The API schema and UI job semantics are in [operations-contracts.md](../refactor/operations-contracts.md).

Initial installation with `--service` waits for the installed version at `/api/health`. If health fails, the installer reports failure and preserves the selected release and data directory for inspection; service registration alone is not reported as a healthy installation.
