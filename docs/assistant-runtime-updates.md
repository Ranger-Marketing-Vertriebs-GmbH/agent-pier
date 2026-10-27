# Managed assistant runtime updates

The installer prepares the OpenClaw and Node versions shipped in AgentPier's runtime
manifest (`--with-assistants`, or a rerun with assistants enabled). After an
AgentPier update, an enabled installation stages that candidate in the background
at startup, under the installation lock, without changing `assistants/runtime.json`
and without delaying the start. A first installation selects its initial runtime;
subsequent starts use the existing selection. No upstream updater
or arbitrary version input is exposed.

**Agents › Runtime › OpenClaw updates** shows the current and target versions (the old address `/settings/assistants` opens this tab). Preparing the update
does not interrupt work. Activation enters maintenance, checks assistant/channel/
scheduled work, stops the owned Gateway, and creates a private snapshot before
switching the selection. Authenticated readiness and read-only reconciliation must
succeed before admission resumes. Active and uncertain work must be resolved first;
the updater never cancels or resends requests.

When the candidate has a different OpenClaw version, activation runs OpenClaw's own
migration between the snapshot and the candidate's first start, in phase `migrating`
(shown as "Migrating data"): the candidate's `openclaw doctor --fix --non-interactive`,
in the stopped runtime's environment, with `OPENCLAW_SERVICE_REPAIR_POLICY=external`
so it never repairs a system service. OpenClaw 2026.10.7 needs it: its Gateway
refuses an agent database below schema 25 until Doctor migrates it. Its output goes
to `logs/gateway-console.log`; only the exit code counts. It takes about 16 seconds
for one agent, is bounded to ten minutes and runs in its own process group, whose
identity (pid, start time, executable, boot) is recorded in the update journal
before it is awaited. Any other end than exit 0 (an error, a signal, the timeout, an
unreadable identity) fails the activation with `UPDATE_MIGRATION_FAILED` and
restores the snapshot like any failed activation. After every run AgentPier removes
what Doctor keeps for its own manual recovery, because it holds private data and
credentials in plain form: the `*.pre-startup-migration-*.bak` copy of each
migrated database with its `-wal`, `-shm` and `-journal` files, and the
`state.update-captures/` folder beside `state/`. A rollback removes them as well.
For Doctor's run AgentPier takes every plain `models.providers.*.apiKey` out of
`openclaw.json` and puts the keys back afterwards, on success and on failure.
2026.10.7's Doctor would otherwise copy each key into OpenClaw's auth profile store
(`config_machine_state`, `authProfiles.store`), where it outranks `openclaw.json`: the
model would first receive a key the owner had since rotated, and a removed key would
stay in OpenClaw's state and its backups. A crash in between restores the snapshot,
keys included.
Startup recovery of an activation that crashed in `migrating` first stops a Doctor
that outlived AgentPier, but only a group it can attribute to the recorded one (the
same boot, every member started after it, one running the runtime's own Node). A
group it cannot attribute while it still exists keeps the update in
`recovery_required`, retried at the next start, instead of restoring under a
running migration. A same-version runtime change (a new Node or lock) runs no
migration.

The snapshot covers Gateway home, state and workspaces, plus all AgentPier SQLite
ledgers under the assistant root. Gateway home/state files that start with the SQLite header are copied with
`VACUUM INTO`, so each copy is self-contained; every other file, including any
database in a workspace, is copied byte for byte. Metadata records the previous and candidate runtimes,
schema-sensitive ledger digests, each ledger table's highest row at the fence and
snapshot integrity. Files use mode 0600 (owner execute bits are kept) and directories 0700. The snapshot runs on asynchronous file I/O and does not block other requests.
Files are copied with `COPYFILE_FICLONE`: a copy-on-write clone only where the
platform supports it through Node (Linux btrfs or XFS reflinks); everywhere else,
macOS included, each file is copied in full. Every file is flushed to disk, which
costs a few milliseconds per file (measured on APFS: about 5 ms); a snapshot of
many small files therefore remains bound by their number rather than their size.

Installed dependencies are not part of the snapshot: every `node_modules` folder
below `workspaces/`, at any depth, is left out with everything inside it and listed
under `omittedDependencies` in the snapshot manifest. A Remotion project's
dependencies, for example, can be several GB in hundreds of thousands of files.
A rollback keeps the live ones: before it replaces the workspaces it moves each
listed folder by rename into `backups/<id>/dependencies/`, and after the restore
moves it back to the same place. A folder that cannot be moved (another file
system, a missing parent after the restore) is deleted with the rest of the live
tree, logged, and missing afterwards; the agent then installs the dependencies
again (for example with `npm install`). A rollback repeated after a crash returns
what an earlier attempt had moved aside. A symbolic link named `node_modules` is a link, not a folder, and is copied
as one. `node_modules` folders below Gateway home and state are copied as before.
While the snapshot runs, the update status shows its progress in bytes against the
estimate of the free-space check ("Creating backup: 2.1 GB of 6 GB"); the estimate
leaves out the same folders.

Real workspaces contain links. Symbolic links are copied as links and never followed.
A relative link that stays inside its tree is part of the integrity digest; absolute
or escaping links are copied too, but excluded from the digest and listed in the
snapshot manifest. Hard-linked files are copied as independent files. Sockets and
FIFOs are skipped and listed. A file owned by another user or an unreadable entry
fails the snapshot; the update status names its relative path (`SNAPSHOT_FAILED`).

Credentials are sealed in the backup with AES-256-GCM: OpenClaw's auth stores
(`auth-profiles.json`, `auth-state.json`, `auth.json`, `oauth.json` and
`state/credentials/`), its credential tables (`auth_profile_store`,
`auth_profile_state`, `secret_store_entries`, `config_machine_state`, MCP OAuth
stores, device and worker credential tables), the secret members of `openclaw.json` and of each copy beside
it that parses as JSON, such as `.bak*` and `.last-good` (Gateway, cron and plugin
tokens, provider API keys, headers and MCP server environments; a copy that does not
parse is left out) and the Telegram bot tokens in
`channels.sqlite`. Each backup has its own key under `assistants/backup-keys/`
(0600), never inside the backup. Logging out of a model account, changing a provider
connection, or rotating or disconnecting a Telegram bot destroys every backup key
before the change, once the change has been admitted (a change refused for active
work or a running update keeps the keys). Keys are unlinked after a best-effort
overwrite; the guarantee rests on unlinking and on keeping keys out of backups, not
on the overwrite reaching the storage medium. Update backups written before sealing
existed (snapshot format 1) hold these credentials in plain text; the same
revocation deletes them entirely. A later rollback restores history and state but leaves the
affected credentials absent; the status asks the owner to sign in again. MCP OAuth
logins are the exception: a logout keeps the keys, because host backups never hold
them. AgentPier remembers each cleared MCP login (name, URL, time; at most 500), and a
rollback queues every one cleared since the snapshot as a deferred logout before the
Gateway starts again, so a server with that name and URL stays uncompiled until the
logout went through. Deepgram
keys live outside the restore boundary. The per-start Gateway TLS key is not part of
any snapshot; it is generated again on each start. Central accounts and coding
sessions are outside this restore boundary. Backups must not be attached to
diagnostic reports.

Host backups (Settings → Operations → Backups) include `assistants/` except `logs/`, `runtimes/`,
`npm-cache/`, `tmp/`, `backups/`, `tls/`, `backup-keys/`, `state.update-captures/`
(Doctor's plain pre-repair capture, should one survive a crash), the Gateway ownership
record, the reminder webhook secret and the host-bound runtime state (`runtime.json`,
`candidate.json`, `update.json`, `runtime-maintenance.json`), and, as in update
snapshots, every `node_modules` folder below `workspaces/`. A host backup is refused
with 409 while a runtime update or provider change is running; update or maintenance
state left behind without one (a crash, a failed recovery, a dormant install) skips
the agent data with a declared omission instead. The agents' private content
(workspaces with attachments, `shares/`, OpenClaw's transcripts, session index,
media and memory index, every file below `state/` outside a configuration
allowlist, and the private rows of the agent databases, whose public copies keep
only configuration tables) is archived only in backups with history and a
passphrase, sealed; see
[backups](backups.md#what-a-backup-holds). Live databases are copied
consistently first. MCP OAuth logins (`mcp_oauth_stores`,
`mcp_oauth_pending_authorizations`) are always left out, like the MCP servers they
belong to; a restore drops them from older backups too. Absolute paths below `assistants/` in `openclaw.json` (and its
`.bak*` and `.last-good` copies, sealed like it) and in
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
removes all others with their keys. The owner can also delete a backup by hand under
**System status › Storage › Free up space › Update backups**, which lists each
backup with its date, size and update; it is removed with its key the same way, and is
refused while an update phase, a pending rollback or an unresolved recovery may still
need a backup ([system status](system-status.md#free-up-space)). After an update completes or rolls back, it also
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

This passed with OpenClaw 2026.9.8 and Node 26.7.0 on macOS arm64, and on 2026.10.7,
where the activation also runs Doctor. The subsequent
[cross-version qualification](assistant-release-qualification.md) also passed
2026.9.7 → 2026.9.8, 2026.9.8 → 2026.9.9, 2026.9.9 → 2026.10.3, 2026.9.8 → 2026.10.3
and 2026.10.3, 2026.9.9 and 2026.9.8 → 2026.10.7 activation and rollback after failed
validation. Other version pairs and native hosts remain unqualified.

The update to OpenClaw 2026.10.3 migrates the state database from schema 19 to 20,
which 2026.9.9 and 2026.9.8 refuse. Rollback before commit restores the snapshot
taken before activation, so it works as for any other update; after commit no
downgrade to 2026.9.x is possible. The update to OpenClaw 2026.10.7 is one-way in
the same way: its Doctor migrates each agent database from schema 24 to 25 (and the
state database of a 2026.9.x installation from 19 to 20), and 2026.10.3, 2026.9.9 and
2026.9.8 refuse the migrated agent databases. Before commit the snapshot restores the
previous runtime and its schema-24 data; after commit the update panel offers only
the pinned 2026.10.7, and retention has removed the previous installation. An older
AgentPier (2.6.x or earlier) does not accept 2026.10.7 either: its team plugin
refuses every OpenClaw version outside its own pin and rollback targets. The installer now also consumes the reviewed dependency lock described below;
all separately downloaded package archives carry integrity checks.

## Locked dependency installation

The runtime manifest pins OpenClaw, Node and the npm bundled with that Node archive.
`runtime-lock/package.json` and `runtime-lock/package-lock.json` ship with AgentPier.
Their combined SHA-256 (package bytes, a NUL separator, then lock bytes) is pinned in
the manifest. The graph fixes registry tarball versions and SHA-512 integrities,
including platform-specific optional packages. Bundled dependencies are covered by
their containing package archive's integrity. They are not listed in the lock:
`npm install --package-lock-only` does not record the children of a bundled
dependency, so Dependabot cannot report advisories for them. Since OpenClaw 2026.10.7
that is npm's own bundle and `chrome-devtools-mcp`, the only package OpenClaw still
bundles; `@openclaw/proxyline` and `undici` are ordinary dependencies now and appear
in the lock.

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

## Bundled search plugins

The runtime also contains the official OpenClaw web search plugins
`@openclaw/duckduckgo-plugin`, `@openclaw/perplexity-plugin` and
`@openclaw/brave-plugin`, each at the OpenClaw version (2026.10.7). They are exact root
dependencies in `runtime-lock/package.json`. The manifest pins each one's
package name, version, plugin id and npm SHA-512 integrity (`searchPlugins`), and
the lock check refuses a graph whose plugin entry differs from the pin or does not
come from the npm registry. `npm ci --ignore-scripts` installs them with the rest
of the graph; they have no dependencies of their own and only a peer dependency on
`openclaw`. Nothing is downloaded at Gateway start.

After `npm ci`, the installer checks each plugin directory
(`app/node_modules/@openclaw/<id>-plugin`): its `package.json` must name the pinned
package and version, and its `openclaw.plugin.json` the pinned id. The receipt
records the pins. The runtime descriptor (`install()`, `ensureAssistantRuntime()`
and `selectedAssistantRuntime()`) exposes them as
`searchPlugins: { duckduckgo: { id, directory }, perplexity: …, brave: … }`.
For a selected runtime, the pins come from its receipt: a runtime installed before
the plugins were bundled, such as one from an earlier lock, reports
`searchPlugins: {}`. A Gateway loads a plugin only when its
configuration names the directory in `plugins.load.paths` and the id in
`plugins.allow`; AgentPier compiles both only for the provider chosen in the web
search settings, and only while an agent uses web search. A plugin directory that
no longer matches its pin (name, version, id, or a symbolic link) fails the
selected runtime's installation check, so the Gateway does not start even when no
agent uses web search.

Existing installations receive the plugins through the normal update path. The
plugins change the lock digest, so an AgentPier update stages a new candidate
installation next to the selected runtime even when the OpenClaw version stays the same.
Activation then switches to it through the backup, validation and rollback flow
described above.

## Fresh native qualification

Run `node scripts/verify-assistant-installation.mjs`. It invokes the shipped installer
in a new private temporary directory, verifies exact Node/npm/OpenClaw versions and
lock receipt and the bundled search plugins, checks authenticated Gateway access, creates a synthetic agent/session,
and verifies history after restart. A second stage must reuse the installation
without downloading/executing an installer or changing the selected runtime/running
Gateway. All owned processes and temporary state are removed; no model credentials
or inference requests are needed.

The `Assistant runtime` CI workflow exercises native Linux x64/ARM64 and macOS
x64/ARM64 runners. A local macOS ARM64 run passed; consult the workflow for the other
host results. This fresh-install smoke test does not replace adjacent-version
activation/rollback tests or qualification of every optional upstream feature.

The same workflow's `native-contracts` job (Ubuntu x64 on pull requests that touch
assistants, assistant channels or `tests/**/assistant*`, macOS arm64 after the merge
as well, and nightly and before a release also Ubuntu arm64 and macOS x64)
provisions the pinned runtime with `scripts/provision-assistant-contracts.mjs`. That
script runs the installer's `--with-assistants` step against a temporary data
directory. The job caches only `assistants/runtimes`, keyed by OS, architecture,
version, Node version and `dependencyLockSha256`. It then runs every deterministic
native contract with the `AGENTPIER_ASSISTANT_*` variables set. Model endpoints,
accounts and channels are simulated, and no secrets are used. The job fails if any
contract skips. The live provider test stays manual because it needs real
credentials. The cross-version tests need a predecessor runtime, which the current
installer cannot install: the workflow's `cross-version` job (nightly and before a
release) checks out the release tags whose pins are still `rollbackTargets` and
installs each predecessor with that tag's own provisioning script (see
[release qualification](assistant-release-qualification.md#update-paths-installed-users-take)). Native contracts locate OpenClaw internals by their exported symbol
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
new graph with pinned npm and prints its digest. The root dependencies are
OpenClaw's archive plus the manifest's `searchPlugins` pins. With `--keep-graph`
as the last argument, npm starts from the shipped lock and only adds what is
missing, for example after adding a pinned plugin. The qualified transitive graph
then stays unchanged; without the flag, the whole graph is resolved again.
**Do not use `--keep-graph` for a security alert or an OpenClaw version change:**
it keeps every already locked transitive version, including the vulnerable or
outdated one the refresh is meant to replace. Those refreshes always resolve the
whole graph. Copy both reviewed JSON files to
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
