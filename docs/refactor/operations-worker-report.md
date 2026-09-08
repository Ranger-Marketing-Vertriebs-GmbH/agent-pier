# Operations implementation report

The operations backend, HTTP API, CLI, release packaging, installer and service adapters are implemented. No commits, remote deployments, global installations or model calls were performed by this worker. Root owns composition, audit, imported pipeline guards and final deployment; the frontend worker owns Settings views.

## Contracts and delivered behavior

The complete HTTP schemas are in [operations-contracts.md](operations-contracts.md). Operational commands, portable storage boundaries and restore/release limitations are in [operations-portability.md](../research/operations-portability.md).

- `Operations({config,audit,withSnapshotBarrier,doctorOptions,releaseOptions})` supplies shared diagnostics, persistent jobs, backups, fresh-target restore, imported AgentBus history and versioned releases. Root mounts `operationsRoutes` outside the ordinary mutation lease so backup capture can acquire its exclusive snapshot barrier.
- Diagnostics use bounded local checks and read-only SQLite checks. Deep mode selects full SQLite integrity checking; it does not probe remote credentials or manufacture service health.
- Backups capture application metadata under the provided barrier and snapshot each SQLite database. Compression and optional scrypt/AES-GCM credential encryption follow capture. Native external writers remain independent; consistency is explicitly per component for those files.
- Restore validates checksums, paths, embedded database schema versions and optional credential authentication before publishing an absent target. Project mappings recalculate local identity. Imported sessions and pipelines are history only; capabilities, native request channels, GitHub bindings and push/device state cannot reactivate. Audit identities and timestamps survive import. Imported AgentBus messages have a paginated read-only API.
- Release artifacts contain production dependencies and an official checksum-verified Node runtime. Staging validates platform/schema/checksums and runs a relocated import smoke. Activation switches the stable pointer, restarts only the configured web service and requires expected version plus a new instance identity. Failed health restores the prior compatible release. Database rollback is never implied.
- Old releases remain available to existing native helpers. The stable launcher retains a separate data directory. Linux helper launch retains explicit user-service bus/configuration environment without inheriting API secrets.
- `sh scripts/install.sh` bootstraps a private Node runtime when required. Dependency installation requires explicit `--install-dependencies`; service registration requires explicit `--service` and only reports success after expected-version health confirmation. macOS uses existing Homebrew; supported Linux bootstrap uses apt. The CLI and release workflow are reusable without host-specific usernames.

## Review corrections

Regression tests cover preservation of an existing restore parent's permissions, removal of native request metadata, sanitization of capability hashes from temporary database snapshots without touching live capabilities, rejection of future embedded SQLite schemas, accessible imported AgentBus messages, background operation failure audit events, and Linux detached helper environment preservation, and initial installer service health confirmation.

## Verification

The focused command below passed 33 tests, including six unchanged service tests:

```sh
node --test tests/integration/operations-data.test.js tests/integration/operations-release.test.js tests/integration/operations-restore-policy.test.js tests/integration/operations-session-survival.test.js tests/integration/operations-sqlite-snapshot.test.js tests/blackbox/operations.test.js tests/property/operations-archive.test.js tests/unit/operations-jobs.test.js tests/matrix/operations-doctor.test.js tests/matrix/operations-installer.test.js tests/matrix/operations-release-boundary.test.js tests/integration/service.test.js
```

The archive property suite also passed with `FC_SEED=173205 FC_RUNS=300`. Scoped ESLint, Prettier and `sh -n scripts/install.sh` passed. Every owned source file is below 600 formatted lines.

The real synthetic tmux test verifies a native child PID and an old-release helper remain usable through backup, activation and rollback, and that the restored application only exposes stopped imported history. An independent SQLite writer test verifies transaction-consistent snapshots while the original writer continues.

An actual temporary production packaging run installed 197 production dependencies into private staging, bundled official Node 22.22.2, deleted source staging, then extracted and successfully imported the relocated application and native dependencies. The resulting Darwin arm64 archive was 86,642,434 bytes (SHA-256 `ce36199f58d40717acf659b1c0c88825531fb1d79c579d97267b8a03762b7b66`). Temporary artifacts were removed. No release was published or live installation activated.

## Boundaries for deployment

Root still performs complete repository/browser/CI checks and the authorized Mac mini deployment. Restore selects a fresh data directory and does not switch a running application to it. Reauthentication can be necessary for machine-bound native logins even with encrypted credentials. Native executable installs, worktrees and push subscriptions do not migrate. Archive size limits are enforced rather than silently omitting data. Release channels use HTTPS and checksums; no independent publisher signature is claimed. An interrupted activation lock requires inspection before another activation; old versions are not automatically pruned.
