# Release session migration

Date: 2026-09-13

## Problem

Old application releases cannot be removed from **Settings → Updates → Clean up old
releases** while any running session still references them. A session references the
release it was started from through three live dependencies: the terminal launcher
process (`<release>/server/terminal-launcher.js`) that wraps the CLI for the whole
session lifetime, the AgentBus MCP server the CLI spawns from `<release>/vendor/`, and
the binding/AgentBus hooks the CLI invokes from `<release>/server/` on every event.
Deleting the release would silently break chat delivery, native binding and peer
communication for that session.

The existing cleanup detects this through `ps` and refuses with the reason `inUse`.
Users can only wait for sessions to end or reload each session by hand. Nothing tells
them which sessions block a version, and nothing migrates them.

## Goal

1. In the cleanup dialog, show which sessions hold a blocked version and migrate them to
   the active release through the existing session reload engine, then delete the
   version automatically once the last session has moved.
2. When activating a staged release, optionally migrate all running sessions to the new
   release after the web service has restarted on it and the activation is verified.

## Non-goals

- No release version persisted into session records. Process-to-session mapping is
  derived from `ps` output, which already exists for cleanup.
- No migration offer for CLI (claude/codex/opencode) updates. A reload re-resolves CLI
  binaries anyway, so migrated sessions pick up CLI updates as a side effect.
- No migration job survival across a web-service restart. Individual reloads survive
  through their existing per-session persistence where the engine already supports it;
  the surrounding job ends without deleting anything.
- No automatic retry of failed reloads.

## Key constraints

**Reloads bind to the running server's release.** A reload rebuilds the tmux command,
hook environment and MCP paths from the web server process that executes it. A reload
executed before activation rebinds the session to the **old** release. "Activate and
migrate" must queue the reloads after the new server has booted on the new release
**and** the activation helper has confirmed health, because a failed health check rolls
the symlink back within seconds.

**Reloads must not run inside `createApplication`.** The server starts listening only
after `createApplication` resolves (`server/index.js`). A reload on an idle session
replaces the tmux session inline and serialises on the reload queue; awaiting that at
boot would delay `/api/health` and could itself trigger the activation rollback.

**Reloads must not run before MCP services exist.** `restartReload` and `prepareReload`
skip the AgentPier tools MCP when `services.sessionMcp` is absent. The migration service
is therefore constructed after `services.sessionMcp` in `server/app.js` and executes
nothing until the HTTP server emits `listening`.

**`server/features/sessions/session-manager.js` is at the 600-line structure limit** and
must not be touched.

## Prerequisite fix: cleanup audit action

`Operations.cleanupReleases` records `release.cleaned`, which `auditAction` rejects
(`server/features/audit/audit-schema.js` has a closed verb set). The job therefore ends
`failed` after the directory has already been removed. Change it to `release.deleted`
with `details: { version }` per removed version and `resourceId: job.id`, and cover the
job with an integration test that uses a real `AuditStore` and asserts `succeeded`.

## Server design

### 1. Session mapping in `server/features/operations/release-cleanup.js`

A new pure helper `releaseSessionReferences(output, releasePath)` classifies every `ps`
line that references `releasePath` (after `releaseProcessReferences` has collapsed tmux
lines). Classes:

- **session**: matches
  `terminal-launcher\.js'?\s+'?(?:\S*/)?sessions/(<uuid>)\.launch\.json'?`. The launch
  file is unlinked at spawn but its path stays in the launcher's argv. Matching on the
  `sessions/<uuid>.launch.json` suffix avoids realpath-versus-resolve mismatches of the
  data directory, and the optional quotes tolerate a lingering `sh -c '…'` wrapper.
- **helper**: the line contains one of the session-owned helper paths under the release:
  `vendor/agentbus/`, `server/native-session-binding.js`,
  `server/native-session-opencode.js`, `server/github-credentials.js`,
  `server/git-credential.mjs`, `server/ssh.mjs`, `server/lib/`, or a Codex/Claude CLI
  line whose release references are all inside hook or MCP configuration arguments
  (`-c hooks.…`, `mcp_servers.…`). These are children of a session and vanish with it.
- **node-only**: the line's only release reference is `<release>/bin/node`. Sessions put
  that node first on their `PATH`, so user MCP servers, `npx` and dev servers started by
  the CLI show up here. They are usually session children but cannot be attributed.
- **unidentified**: everything else, including launcher lines without a launch file,
  `server/features/pipelines/verify-supervisor.js` and `release-helper.js`, which run
  detached and are not owned by a session.

`cleanupState` gains per version: `sessionIds`, `nodeOnlyProcesses` (count), and
`unidentifiedProcesses` as `[{ reference }]` where `reference` is the release-relative
path of the first release reference on that line (never the full command line, which can
carry tokens). The `inUse` decision itself does not change.

### 2. New service `server/features/operations/release-session-migration.js`

Constructed in `server/app.js` after `services.sessionMcp` is ready:

```js
services.releaseMigration = new ReleaseSessionMigration({ services, operations });
server.once("listening", () => services.releaseMigration.resumeAfterActivation());
```

Dependencies: `operations.releases`, `operations.jobs`, `operations.audit`,
`services.sessions`, `services.reload`, `services.activity`.

#### `plan(version)`

```json
{
  "version": "1.17.5",
  "deleteReason": "inUse",
  "migratable": false,
  "nodeOnlyProcesses": 1,
  "unidentifiedProcesses": [
    { "reference": "server/features/pipelines/verify-supervisor.js" }
  ],
  "sessions": [
    {
      "id": "…",
      "name": "…",
      "tool": "claude",
      "status": "running",
      "eligible": true,
      "reason": null,
      "activity": "idle",
      "reload": "idle",
      "reloadError": null
    }
  ]
}
```

- `eligible` / `reason` come from `services.reload.status(id)`.
- `activity` is `idle`, `working`, `waiting`, `unknown` or `stopped`. The UI groups
  `working`/`waiting` as "busy" and shows `unknown` separately because `when-idle` waits
  indefinitely on it.
- `reload` is the session's reload state; `waiting` and `reloading` count as in flight.
  `reloadError` exposes the engine's stored error for failed reloads.
- Sessions in `sessionIds` that no longer exist are omitted.
- `migratable` is true only when `deleteReason === "inUse"`, `unidentifiedProcesses` is
  empty and every listed session is eligible or in flight. Node-only processes do not
  block; they are re-checked before deletion.
- Versions whose `deleteReason` is not `inUse` return `migratable: false` with an empty
  session list.

#### `migrate(version, { interrupt })`

Starts an operations job of kind `release-migrate`. Before starting: refuse with
`migrateBusy` (409) if `jobs.running("release-")` reports any running release job.

Job body:

1. Re-run `plan(version)`. If not `migratable`, throw `migrateChanged`. Nothing has been
   requested yet.
2. For every session not in flight, call `services.reload.request(id, …)` with a fresh
   UUID `requestId`, mode `now` + `interrupt: true` when `interrupt` is set, otherwise
   mode `when-idle`. A request that throws marks the session failed with the error
   message; the job continues with the rest.
3. Poll every second. For each session, look up its record:
   - gone → released;
   - `reload.requestId` equals ours (or the session was in flight when the job started)
     and `reload.state === "completed"` → reloaded;
   - `reload.state === "failed"` → failed;
   - `reload.state` in `waiting`/`reloading` → still in flight, regardless of `status`
     (replacement sets `stopped` transiently);
   - `status === "stopped"` and not in flight → released.
     The loop exits when no session is in flight, when `jobs.closed` becomes true
     (shutdown), or when the job is cancelled. Shutdown or cancel throws
     `migrateInterrupted` / `migrateCancelled` with the partial result; nothing is deleted
     and the individual reloads continue under the engine's own rules.
4. If any session failed: throw `migrateFailed` with
   `result: { failedSessions: [{ id, error }], reloadedSessions: [ids] }`.
5. Wait for remaining references to disappear: re-run the mapping up to 30 times at one
   second intervals while only helper or node-only lines remain (orphaned MCP children
   of the killed CLI exit asynchronously). If references persist, throw
   `migrateBlocked` with `result: { remaining: [{ reference }] }`.
6. Call `operations.releases.cleanup([version])`. Its own re-validation still applies; a
   new session started on the version meanwhile yields the existing `cleanupChanged`.
7. Success result `{ reloadedSessions: [ids], removedVersions: [version] }`. Audit
   `release.deleted` with `resourceId: job.id`, `details: { version, count }`.

`cancel()` sets a flag that step 3 observes. It is exposed as
`DELETE /operations/releases/cleanup/:version/migrate` and answers 404 when no migrate
job for that version is running.

#### `resumeAfterActivation()`

Runs on `listening`, never awaited by the caller, never throws. Reads
`<dataDir>/operations/post-activation-reload.json` (`{ to, jobId, requestedAt }`). If
absent, return. Otherwise poll every two seconds, for at most ten minutes, until the
activation job `jobId` (via `operations.jobs.get`) leaves `running`:

- `succeeded` with `result.activated === true` and no `release-activation.lock` present:
  for every running session whose reload status is eligible and not in flight, request a
  `when-idle` reload without interrupt. Per-session errors are logged, never thrown.
  Audit `release.refreshed` with `resourceId: jobId`, `details: { version: to, count }`.
- any other outcome, or timeout: do nothing.

The marker is deleted before any reload is requested so a crash cannot replay it.
Sessions that are ineligible stay on the old release and appear in the cleanup dialog.

### 3. Activation flag

`POST /operations/releases/activate` accepts `reloadSessions`. `Operations.activate`
validates `typeof reloadSessions === "boolean"` (else 400), strips it from the input
passed to `launchActivation` so it never lands in the helper request file, and, inside
the job action after `launchActivation` has resolved (helper spawned), writes the marker
with the job id and the staged manifest's version. If `launchActivation` rejects, no
marker exists. Rollback never writes a marker. `activate` and `cleanupReleases` refuse
with `migrateBusy` while a `release-migrate` job is running.

### 4. Jobs (`server/features/operations/jobs.js`)

- `running(kindPrefix)` scans job files and returns true when any job with that kind
  prefix is `running` (applying the existing external heartbeat rule).
- The failure branch persists `error.result` when present and widens the `errorCode`
  passthrough to `/^(?:cleanup|migrate)(?:Invalid|Busy|Changed|Failed|Blocked|Interrupted|Cancelled)$/`.
- `closed` is readable by job bodies.

### 5. Routes (`server/http/routes/operations.js`)

`operationsRoutes` additionally receives `releaseMigration`.

- `GET /operations/releases/cleanup/:version/sessions` → `plan(version)`.
- `POST /operations/releases/cleanup/:version/migrate` body `{ interrupt?: boolean }`
  (validated as boolean) → `202 { job }`.
- `DELETE /operations/releases/cleanup/:version/migrate` → `204` or `404`.

`:version` is validated with `releaseVersion` in the route before any lookup.

## UI design

### Cleanup card (`web/features/operations/ReleaseCleanup.jsx`)

For a version with `deleteReason === "inUse"` the row gains a `<details>` block
"Sessions anzeigen" that loads the plan on open (`useResource` with the sessions route,
`poll: 3000` while open). Each session shows name (or id prefix), tool and a state chip:
"Bereit", "Beschäftigt", "Zustand unbekannt", "Wird neu geladen", "Wartet auf
Freigabe im Terminal" (reload `reloading` for longer than 30 s), "Fehlgeschlagen" with
`reloadError`, or the ineligibility reason ("Pipeline-, Login- oder Shell-Session",
"Keine verifizierte Unterhaltung").

Below the list:

- **"Sessions umziehen und Version löschen"** — enabled when `migratable`. The
  confirmation names the version and the session count and explains that busy sessions
  move after finishing their current step and that sessions with unknown state wait
  until the CLI is recognisably idle.
- **"Sofort umziehen und löschen"** — shown when at least one session is busy or
  unknown. The confirmation warns that running work is interrupted. Sends
  `interrupt: true`.

When not migratable: buttons disabled and a hint. Distinct hints for ineligible sessions
("stop these sessions manually") and for unidentified processes, listing their
`reference` values. Node-only processes get an informational line ("N Node-Prozesse aus
dieser Version werden nach dem Umzug erneut geprüft").

While a `release-migrate` job runs, the card shows a "Umzug abbrechen" button that calls
the `DELETE` route. All other cleanup buttons stay disabled while any job is pending,
matching current behaviour.

### Job panel (`web/features/operations/OperationJob.jsx`)

Success for `release-migrate`: "Version gelöscht, N Sessions neu geladen". Failure:
`copy.cleanupErrors[errorCode]` extended with the new codes, plus `failedSessions`
(id and error) or `remaining` references from `job.result` when present.

### Activation confirmation (`web/features/operations/UpdatesPage.jsx`)

`ConfirmOperation` gets an optional `children` slot rendered between description and
buttons. The activate confirmation renders a checkbox "Laufende Sessions danach auf die
neue Version umziehen" (default off) with help text: the migration starts after the new
version has passed its health check; busy sessions move after finishing their current
step; nothing is interrupted; sessions that cannot be reloaded keep running on the
previous version. The rollback confirmation renders no checkbox.

### Copy

All new strings go into both `operationsCopy` exports, `web/lib/i18n/de/operations.js`
and `web/lib/i18n/en/operations.js`.

## Error handling summary

| Situation                                                                                              | Behaviour                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan changed before job started (incl. activation lock)                                                | `migrateChanged`, no reload requested                                                                                                                                                                         |
| Session eligible in plan, `request` rejects (model pending, provider changed, request limit, shutdown) | counted as failed → `migrateFailed`, error shown per session                                                                                                                                                  |
| One reload fails                                                                                       | wait for the rest, then `migrateFailed`, nothing deleted                                                                                                                                                      |
| Reload stuck in `reloading` (trust prompt)                                                             | job stays open, UI marks the session, user may cancel the job; the reload itself continues                                                                                                                    |
| Session stopped or deleted during job (not in flight)                                                  | counted as released                                                                                                                                                                                           |
| Orphaned helper or node-only processes after all reloads                                               | bounded wait, then `migrateBlocked` with references                                                                                                                                                           |
| New session started on the version during job                                                          | `cleanupChanged` from cleanup; reloaded sessions stay migrated                                                                                                                                                |
| Another release job running                                                                            | `migrateBusy`, job not started; activation and cleanup refuse likewise during a migration                                                                                                                     |
| Web restart during job                                                                                 | job ends `migrateInterrupted` on graceful shutdown or `interrupted` after a kill; reloads in `waiting` or with a started replacement survive per the engine's rules, other `reloading` states become `failed` |
| Activation failed, rolled back, timed out, or lock still held                                          | marker discarded, nothing requested                                                                                                                                                                           |
| Reload after activation fails for a session                                                            | visible in the session list; version stays blocked                                                                                                                                                            |
| `ps` unavailable                                                                                       | plan reports `migratable: false`; existing cleanup behaviour                                                                                                                                                  |

## Testing

- `tests/integration/release-cleanup.test.js`: `releaseSessionReferences` classes from
  fixture output: quoted and unquoted launcher lines, launcher without launch file,
  helper children, Codex CLI line with hook TOML, node-only line, verify-supervisor line,
  foreign process; `cleanupState` exposes the new fields; the cleanup job succeeds with a
  real `AuditStore` (prerequisite fix).
- `tests/integration/release-session-migration.test.js` (new): plan with mixed
  eligibility and process classes; job success with a fake reload service that completes
  on poll; partial failure leaves the release and persists `failedSessions`; plan change
  aborts before any request; transient `stopped` during replacement is not treated as
  released; bounded wait for helper lines then `migrateBlocked`; cancel and shutdown end
  the job without deleting; `resumeAfterActivation` with succeeded, failed, lock-held,
  missing marker and timeout; boot never throws when a request rejects.
- `tests/integration/operations-release.test.js`: `activate` with `reloadSessions`
  writes the marker only after the helper spawned and strips the flag from the request
  file; non-boolean value is rejected; rollback writes no marker; `activate` refuses
  during a running migrate job.
- `tests/integration` for `jobs.running` and the persisted failure result.
- `tests/browser/release-cleanup.spec.js`: session list with all chips, migrate
  confirmation, immediate migrate warning, disabled state with ineligible sessions and
  with unidentified processes, cancel button, job success and failure rendering.
- `tests/browser/update-activate.spec.js` (new): activation checkbox sends
  `reloadSessions: true`; rollback shows no checkbox.
- `npm run check` plus `npx playwright test tests/browser/release-cleanup.spec.js
tests/browser/update-activate.spec.js` before finishing; browser specs are not part of
  `npm test`.

## Documentation

- `docs/installation.md`: cleanup section describes the session list, both migrate
  actions, the cancel option, node-only and unidentified processes, and the activation
  option.
- `docs/session-reload.md`: note that release migration uses the same reload with the
  same exclusions and the same behaviour for unknown activity and trust prompts.
