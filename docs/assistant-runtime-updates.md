# Managed assistant runtime updates

The installer prepares the OpenClaw and Node versions shipped in AgentPier's runtime
manifest (`--with-assistants`, or a rerun with assistants enabled). After an
AgentPier update, an enabled installation stages that candidate in the background
at startup, under the installation lock, without changing `assistants/runtime.json`
and without delaying the start. A first installation selects its initial runtime;
subsequent starts use the existing selection. No upstream updater
or arbitrary version input is exposed.

Settings > Agents > Agent service shows the current and target versions. Preparing the update
does not interrupt work. Activation enters maintenance, checks assistant/channel/
scheduled work, stops the owned Gateway, and creates a private snapshot before
switching the selection. Authenticated readiness and read-only reconciliation must
succeed before admission resumes. Active and uncertain work must be resolved first;
the updater never cancels or resends requests.

The snapshot covers Gateway home, state and workspaces, plus all AgentPier SQLite
ledgers under the assistant root. Gateway home/state files that start with the SQLite header are copied with
`VACUUM INTO`, so each copy is self-contained; every other file, including any
database in a workspace, is copied byte for byte. Metadata records the previous and candidate runtimes,
schema-sensitive ledger digests, each ledger table's highest row at the fence and
snapshot integrity. Files use mode 0600 (owner execute bits are kept) and directories 0700. The snapshot runs on asynchronous file I/O and does not block other requests.

Real workspaces contain links. Symbolic links are copied as links and never followed.
A relative link that stays inside its tree is part of the integrity digest; absolute
or escaping links are copied too, but excluded from the digest and listed in the
snapshot manifest. Hard-linked files are copied as independent files. Sockets and
FIFOs are skipped and listed. A file owned by another user or an unreadable entry
fails the snapshot; the update status names its relative path (`SNAPSHOT_FAILED`).

Credentials are sealed in the backup with AES-256-GCM: OpenClaw's auth stores
(`auth-profiles.json`, `auth-state.json`, `auth.json`, `oauth.json` and
`state/credentials/`), its credential tables (`auth_profile_store`,
`auth_profile_state`, `secret_store_entries`, MCP OAuth stores, device and worker
credential tables), the secret members of `openclaw.json` (Gateway, cron and plugin
tokens, provider API keys and headers) and the Telegram bot tokens in
`channels.sqlite`. Each backup has its own key under `assistants/backup-keys/`
(0600), never inside the backup. Logging out of a model account, changing a provider
connection, or rotating or disconnecting a Telegram bot destroys every backup key
before the change, once the change has been admitted (a change refused for active
work or a running update keeps the keys). Keys are unlinked after a best-effort
overwrite; the guarantee rests on unlinking and on keeping keys out of backups, not
on the overwrite reaching the storage medium. Update backups written before sealing
existed (snapshot format 1) hold these credentials in plain text; the same
revocation deletes them entirely. A later rollback restores history and state but leaves the
affected credentials absent; the status asks the owner to sign in again. Deepgram
keys live outside the restore boundary. The per-start Gateway TLS key is not part of
any snapshot; it is generated again on each start. Central accounts and coding
sessions are outside this restore boundary. Backups must not be attached to
diagnostic reports.

Host backups (Settings > Backups) include `assistants/` except `logs/`, `runtimes/`,
`npm-cache/`, `tmp/`, `backups/`, `tls/`, `backup-keys/`, the Gateway ownership
record, the reminder webhook secret and the host-bound runtime state (`runtime.json`,
`candidate.json`, `update.json`, `runtime-maintenance.json`). A host backup is refused
with 409 while a runtime update or provider change is running; update or maintenance
state left behind without one (a crash, a failed recovery, a dormant install) skips
the agent data with a declared omission instead. Live databases are copied
consistently first. Absolute paths below `assistants/` in `openclaw.json` and in
OpenClaw's legacy session index (`state/agents/*/sessions/sessions.json`) are stored
relative to that folder and point at the restored location after a restore; a path
that would leave it rejects the archive. The Gateway's default workspace is set from
the current installation on every start, whatever the configuration says.
Workspaces that exceed the backup budget are left out as a declared omission. When
the remaining agent data alone exceeds it, the whole `assistants` component is left
out with the declared omission "Agent data too large" instead of failing the host
backup. An `openclaw.json` or session index that is not valid JSON is left out with
the declared omission "Unreadable agent runtime files", so the archive stays
restorable; a restore still rejects such files, or escaping paths, in a crafted
archive.
Credentials use the same sealing: with credentials and the feature on, they are sealed
under the backup's own key in `assistants/backup-keys/`, which every logout or
revocation above destroys and which deleting the host backup also removes. Otherwise
they are left out and no key or work folder is created under `assistants/`. A restore
can unseal them only on this host while the key exists; otherwise the restore report
lists `assistants` under credentials needing a login. The Deepgram speech connection
(`speech/`) is not part of host backups. The opt-in switch (`assistant-feature.json`
in the data directory) is not restored either: a restored data directory with stored
agents comes back enabled through the same migration as an upgrade, and installs its
runtime again on first start.

Activation checks free space first: it needs twice the estimated snapshot size and
is refused with `INSUFFICIENT_SPACE` before maintenance or any copy. Retention keeps
the two newest successful backups and the backup of an unresolved recovery, and
removes all others with their keys. After an update completes or rolls back, it also
deletes installed runtimes that neither the selection, the candidate nor an unresolved
rollback target uses. Startup removes all abandoned snapshot work files and, under the installation
lock, installation stages older than one hour; a successful installation clears
the npm download cache.

Before admission resumes, failure can restore the previous Gateway state and runtime
together. AgentPier ledgers must still match their snapshot; an extra recorded effect
or schema change leaves the service stopped instead of erasing that evidence. The
restore path does not replace live database handles. Once the journal records a
commit, recovery preserves current state even if the process crashes while admission
is resuming. The same rule applies after a successful rollback. A damaged journal or
snapshot requires recovery; it does not silently start the candidate.

The application maintenance adapter must gate all mutations, pause and join channel,
team, login and reconciliation workers, and await native webhook handlers after the
Gateway stops. Startup invokes update recovery before starting those workers. The
maintenance adapter also disables native cron before candidate validation and
restores its prior enabled state only after commit. A private maintenance marker
survives process loss during provider changes; recovery refreshes the current
model configuration and resumes current state without restoring an old backup.
Overlapping credential changes and runtime updates are rejected. History reads
serve the cache during maintenance and fence late writes across a maintenance
cycle.

From the snapshot until the post-start check, the ledger connections are fenced:
request, reminder, team and channel writers are refused. Only work inside the
update's validation scope may write, and rows it inserts are recorded. The check
excludes exactly those rows; any other inserted, changed or deleted row still forbids
rollback.

Staging an identical runtime records no candidate, and the status reports
`updateAvailable: false`. Installation takes a cross-process lock
(`runtimes/.install.lock`, created with `O_EXCL`, naming the holder's pid and start
time); a second process gets `RUNTIME_BUSY`, and a lock whose holder is gone is
reclaimed. A selection whose runtime directory is missing is reset and reinstalled
on the next start (`RUNTIME_REINSTALLED`). A selection without a dependency lock is
refused (`RUNTIME_LOCK_MISSING`); staging and activating the qualified runtime
replaces it. The managed team plugin accepts the manifest's runtime and its declared
`rollbackTargets` only.

## Verification

Run the installer, activation, lifecycle and HTTP regression tests:

```sh
node --test tests/unit/assistant-runtime-install.test.js \
  tests/integration/assistant-runtime-activation.test.js \
  tests/integration/assistant-runtime-update.test.js \
  tests/integration/assistant-runtime-lifecycle.test.js \
  tests/blackbox/assistant-runtime-update-routes.test.js
```

The opt-in native test reuses only an installed runtime's immutable executables.
It creates and removes its own temporary mutable state, needs no model credentials,
and verifies staging, same-version activation, authenticated roster access, restart,
and an overdue cron job remaining unexecuted until commit:

```sh
AGENTPIER_ASSISTANT_UPDATE_RUNTIME=/absolute/path/to/installed-runtime \
  node --test tests/integration/assistant-runtime-update-native.test.js
```

This passed with OpenClaw 2026.9.8 and Node 26.7.0 on macOS arm64. The subsequent
[cross-version qualification](assistant-release-qualification.md) also passed
2026.9.7 → 2026.9.8 activation and rollback after failed validation. Other version
pairs and native hosts remain unqualified. The installer now also consumes the reviewed dependency lock described below;
all separately downloaded package archives carry integrity checks.

## Locked dependency installation

The runtime manifest pins OpenClaw, Node and the npm bundled with that Node archive.
`runtime-lock/package.json` and `runtime-lock/package-lock.json` ship with AgentPier.
Their combined SHA-256 (package bytes, a NUL separator, then lock bytes) is pinned in
the manifest. The graph fixes registry tarball versions and SHA-512 integrities,
including platform-specific optional packages. Bundled dependencies are covered by
their containing package archive's integrity.

Before any download, the installer verifies the lock digest and metadata. It then
checks Node and OpenClaw archive integrity and executes the private, pinned npm with
`ci --ignore-scripts --include=optional`. User/global npm configuration and inherited
credentials do not participate. Missing or inconsistent lock data fails installation;
there is no fallback to unconstrained dependency resolution or lifecycle scripts.

A lock fingerprint is part of the installation directory and receipt. A changed
lock can therefore stage a new candidate even when OpenClaw's version is unchanged.
Staging does not overwrite the current selection. A legacy selection without a lock
digest is not started; the update panel offers staging and activating the locked
runtime through the backup, validation and rollback flow. Starting/reusing a locked
installation checks its lock metadata again. This detects changed lock files; it does not claim immutable or
cryptographically attested installed filesystem contents.

## Fresh native qualification

Run `node scripts/verify-assistant-installation.mjs`. It invokes the shipped installer
in a new private temporary directory, verifies exact Node/npm/OpenClaw versions and
lock receipt, checks authenticated Gateway access, creates a synthetic agent/session,
and verifies history after restart. A second stage must reuse the installation
without downloading/executing an installer or changing the selected runtime/running
Gateway. All owned processes and temporary state are removed; no model credentials
or inference requests are needed.

The `Assistant runtime` CI workflow exercises native Linux x64/ARM64 and macOS
x64/ARM64 runners. A local macOS ARM64 run passed; consult the workflow for the other
host results. This fresh-install smoke test does not replace adjacent-version
activation/rollback tests or qualification of every optional upstream feature.

The same workflow's `native-contracts` job (Ubuntu and macOS, nightly and on pull
requests that touch assistants, assistant channels or `tests/**/assistant*`)
provisions the pinned runtime with `scripts/provision-assistant-contracts.mjs`. That
script runs the installer's `--with-assistants` step against a temporary data
directory. The job caches only `assistants/runtimes`, keyed by OS, architecture,
version, Node version and `dependencyLockSha256`. It then runs every deterministic
native contract with the `AGENTPIER_ASSISTANT_*` variables set. Model endpoints,
accounts and channels are simulated, and no secrets are used. The job fails if any
contract skips. Two contracts stay manual: the live provider test needs real
credentials, and the cross-version test needs a predecessor runtime that has no
installer path. Native contracts locate OpenClaw internals by their exported symbol
names (`tests/helpers/openclaw-dist-exports.js`), not by hashed chunk file names. A
rebuilt package therefore keeps working, and a missing symbol fails with a message
that names the OpenClaw version.

## Refreshing the reviewed graph

Only maintainers regenerate the lock, as a source change that receives review and
qualification. Product installation never regenerates it. Use an already verified
managed runtime with the manifest's exact Node/npm versions:

```sh
node scripts/refresh-assistant-runtime-lock.mjs \
  --runtime /absolute/path/to/verified-managed-runtime \
  --output /absolute/path/to/review-lock-output
```

The script uses fresh temporary state, verifies the upstream archive, resolves the
new graph with pinned npm and prints its digest. Copy both reviewed JSON files to
`server/features/assistants/runtime-lock/`, update `dependencyLockSha256` in the
manifest, and run unit checks plus the four native CI installations. A deliberate
refresh may select newer transitive versions and change npm's bundled-package
metadata; the committed lock, not rerunning the resolver, defines an installation.
When changing Node/OpenClaw, also update their checksums, npm version, plugin
compatibility and qualified activation/rollback pairs. Never change private live
runtime files to make qualification pass.

Dependabot never updates `server/features/assistants/runtime-lock/`. The root npm
entry excludes that path, and a dedicated entry for the directory ignores every
dependency, which also stops security-update pull requests. If Dependabot edited that
lock, the lock would no longer match the pinned digest, and every installation would
fail. Dependabot security alerts for that directory still appear, and they must be
resolved with `scripts/refresh-assistant-runtime-lock.mjs` as described above, never
by editing the lock by hand. That
refresh is one reviewed change: it updates both lock files and the manifest digest,
and the `Assistant runtime` workflow must pass with it. `.gitattributes` marks the
lock as generated, so reviews show it collapsed.
