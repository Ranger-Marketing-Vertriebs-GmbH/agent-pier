# SFTP Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents and coding CLIs can list, download, upload, sync and change files on
owner-registered SFTP hosts (password or key), managed, granted, approved and audited
like the existing SSH hosts (AGENTPIER-204).

**Architecture:** SFTP hosts are rows of the unified SSH catalog with `type: "sftp"`;
passwords live beside the SSH identities as 0600 files. A pure-JS `ssh2` client with
in-process host-key pinning sits under `server/features/sftp/` together with pure path,
exclude and plan modules, a transfer engine and a job runner. Coding CLIs reach it
through new `sftp_*` tools of the existing `agentpier_ssh` session MCP server (no
AgentPier card); agents through new actions of their existing `agentpier_ssh` tool,
with SFTP approvals, "Always allow" and activity rows built on the SSH ones.

**Tech Stack:** Node.js 22.13+ ES modules, `ssh2@1.17.0` (client and, in tests,
server), Express, React/JSX, `node:test`, fast-check, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-sftp-access-design.md` (binding,
including "Decisions by the owner" and "Calls made during the design").

**Dependency:** Tasks 6, 7 and 9 build on PR #452 (`feat/tool-call-activity`):
`web/components/ActivityRow.jsx` (`{icon, label, detail, status, tone, defaultOpen,
children}`), `web/features/assistants/ssh-run-note.js` (`sshRunView`,
`sshHistoryText`) and `server/lib/secret-redaction.js` (`redactSecrets`). Rebase onto
`main` once #452 merges; until then rebase this branch onto `feat/tool-call-activity`
before Task 6.

## Global Constraints

- SFTP only; no FTP/FTPS, no shell commands on SFTP hosts, no resumable partial transfers.
- Auth: user + password **or** a managed/imported SSH key; host key pinned via scan + trusted fingerprint confirmation.
- No password or key in argv, env, process list, logs, audit, browser responses, agent/CLI tool results or Telegram; no `sshpass`.
- Passwords stored like SSH keys: 0600 file under `AGENTPIER_DATA_DIR/ssh/`, 0700 directories, omitted from backups like the rest of `ssh/`.
- Reads (list, stat, download, server→local sync without deletes) never ask; every remote write asks agents unless "Always allow" was chosen for that host; any delete (file, folder, sync deletes) always asks.
- "Always allow" is per host and per agent, revocable in the Work tab; it covers upload, overwrite, mkdir, rename and sync without deletes.
- Coding CLIs: no AgentPier approval card; a host granted to the session/project may be used directly.
- Sharing exactly like SSH: owner grants per agent; leads never share with permanent members; temporary members inherit only under **Team members may use shell and SSH**.
- Default excludes `.git` and `.env`; deletes on the target only with `deleteExtra: true` (default false).
- Limits (this plan's choice): 2 GiB and 10,000 files per transfer, checked on a pre-scan before any approval card; 50,000 scanned entries, 60 s pre-scan, 10 s connect, 60 s idle per operation, 2 h per job.
- Local side: uploads need read level, downloads and server→local sync need read-and-write level (project-folder rules, no links out, protected roots); CLI root is the session's launch folder.
- Optional per-host "allowed remote folder": every remote path confined to it, symlinks resolved server-side.
- AGENTS.md: DE/EN with matching keys and `npm run i18n:confirm`; UI guide components only; files ≤ 600 lines; new runtime deps via npm/install path; English docs; delete this plan and the spec before the PR.

## Review Focus

- A Hetzner-style chrooted server (`realpath(".")` is `/`, password offered only as `keyboard-interactive`) → login and listing work. Test: Task 1 `keyboard-interactive password login`.
- Names with spaces, umlauts, leading `-` or a newline → spaces/Unicode transfer intact; control characters are refused with `SFTP_PATH_REFUSED` before anything is written. Test: Task 4 `unusual names`.
- The upload target is a directory where a file goes (or the reverse) → the transfer fails with that path and deletes nothing. Test: Task 4 `type conflict fails without deleting`.
- The connection drops mid-transfer → no `.agentpier-part-*` files left on either side, the job reports the failing path, re-running the sync completes. Test: Task 4 `dropped connection`.
- The owner edits the host (new password or pin) while a job runs or a card is open → the job stops before the next file, the card can no longer run (`ACCESS_CHANGED`). Tests: Task 6 `host edit stops a running job`, Task 7 `edited host cancels the card`.

---

### Task 1: `ssh2` dependency, SFTP client wrapper and test server fixture

**Files:**
- Modify: `package.json` (dependency `"ssh2": "1.17.0"`; `allowScripts`: `"ssh2@1.17.0": false`, `"cpu-features@0.0.10": false` — pure-JS crypto, no native build), `package-lock.json`, `THIRD_PARTY_NOTICES.md` (ssh2, asn1, bcrypt-pbkdf, tweetnacl, safer-buffer with licenses)
- Create: `server/features/sftp/sftp-errors.js`, `server/features/sftp/sftp-client.js`
- Create: `tests/helpers/sftp-server.js`
- Test: `tests/integration/sftp-client.test.js`

**Interfaces:**
- Produces: `sftpProblem(code, status?) -> Error` with `{code, status}`; codes and default statuses: `SFTP_AUTH_FAILED` 502, `SFTP_HOST_KEY_MISMATCH` 502, `SFTP_UNREACHABLE` 502, `SFTP_TIMEOUT` 504, `SFTP_NOT_FOUND` 404, `SFTP_PERMISSION` 403, `SFTP_PATH_REFUSED` 403, `SFTP_LIMIT` 413, `SFTP_TYPE_CONFLICT` 409, `SFTP_PLAN_CHANGED` 409, `SFTP_JOB_NOT_FOUND` 404, `SFTP_BUSY` 429, `SFTP_CANCELLED` 409, `SFTP_FAILED` 502.
- Produces: `openSftp(connection, { signal, connectMs = 10000, idleMs = 60000 }) -> Promise<SftpSession>`; `connection = { host, port, username, hostKey /* "type base64" */, password?, privateKey? /* Buffer */ }`.
- Produces: `SftpSession` methods: `realpath(p) -> string`, `lstat(p) -> {type: "file"|"dir"|"link"|"other", size, mtimeMs} | null` (null on not found), `readdir(p) -> [{name, type, size, mtimeMs}]`, `mkdir(p)`, `rename(from, to, { overwrite = false })`, `unlink(p)`, `rmdir(p)`, `setTimes(p, mtimeMs)`, `readStream(p)`, `writeStream(p)`, `close()`, `closed: boolean`.
- Produces (test helper): `startSftpServer({ users = { deploy: { password: "pw-secret" } }, keyboardInteractive = false, chroot = true } = {}) -> Promise<{ host: "127.0.0.1", port, hostKey, otherHostKey, root, dropAfterBytes(n), failNext(op, status), close() }>` — an in-process `ssh2.Server` whose SFTP subsystem serves a temp directory mapped to `/` (OPEN/READ/WRITE/CLOSE, (L/F)STAT, (F)SETSTAT, OPENDIR/READDIR, MKDIR, RMDIR, REMOVE, RENAME, `posix-rename@openssh.com`, REALPATH, READLINK); never touches the default tmux server or real hosts.

- [ ] **Step 1: Write the failing tests** in `tests/integration/sftp-client.test.js`: `password login lists the root` (`readdir("/")` returns a file written into `root`); `key login` (user configured with a public key, `privateKey` buffer); `keyboard-interactive password login` (`keyboardInteractive: true`, `realpath(".") === "/"`); `pinned key mismatch is refused` (`hostKey: otherHostKey` → rejects with `code === "SFTP_HOST_KEY_MISMATCH"`, no auth attempted); `wrong password` → `SFTP_AUTH_FAILED`; `connect timeout` (a TCP server that never answers, `connectMs: 200`) → `SFTP_TIMEOUT`; `abort signal closes the session`; `rename overwrite uses posix-rename`; `password never in error message` (`String(error)` and `JSON.stringify(error)` exclude `"pw-secret"`).
- [ ] **Step 2: Run** `node --test tests/integration/sftp-client.test.js` — expected FAIL (module not found).
- [ ] **Step 3: Implement** `npm install ssh2@1.17.0 --save-exact`, the allowScripts entries and notices; `sftp-errors.js`; `sftp-client.js`: `hostVerifier` compares the presented key blob with the base64 blob of the pinned line (`Buffer.equals`) and `algorithms.serverHostKey` is limited to the pinned key type; `authHandler` order: `publickey` for a key, else `password` then `keyboard-interactive` answering only a single non-echo prompt with the password; `readyTimeout = connectMs`; an idle timer per call maps to `SFTP_TIMEOUT`; ssh2 status codes map to the codes above (`NO_SUCH_FILE` → `SFTP_NOT_FOUND`, `PERMISSION_DENIED` → `SFTP_PERMISSION`). Then the fixture.
- [ ] **Step 4: Run** `node --test tests/integration/sftp-client.test.js` — PASS; `npm ci` in a clean checkout prints no build of `ssh2`/`cpu-features`.
- [ ] **Step 5: Commit** `feat: add SFTP client and local SFTP test server`

### Task 2: SFTP host type and password storage in the SSH catalog

**Files:**
- Create: `server/features/ssh/ssh-password-store.js`, `server/features/ssh/sftp-host-fields.js`
- Modify: `server/features/ssh/ssh-access-store.js` (create/update/project/remove/connection/test, new `sftpConnection`), `server/features/ssh/ssh-key-store.js` (`project()`/`removeKey` tolerate hosts without key), `server/features/ssh/ssh-management-records.js` (`hostTuple`), `server/ssh.mjs` (refuse SFTP hosts), `server/lib/i18n/de/ssh.js`, `server/lib/i18n/en/ssh.js` (or the catalogs holding `serverMessages.ssh`), `server/lib/i18n/translation-lock.json`
- Test: `tests/unit/sftp-host-store.test.js`, `tests/unit/ssh-password-store.test.js`, extend `tests/integration/assistant-host-backup.test.js`

**Interfaces:**
- Consumes: `openSftp` (Task 1).
- Produces: `SshPasswordStore({ root })`: `write(hostId, revision, password)`, `read(hostId, revision) -> string`, `removeHost(hostId)`, `removeOthers(hostId, keepRevision)`; files `ssh/passwords/<hostId>/<revision>` (0600, directories 0700, `O_NOFOLLOW`, owner uid, one link, ≤ 1024 bytes). `passwordValue(raw) -> string` (1–1024 bytes UTF-8, no NUL/CR/LF).
- Produces: `hostTypes = ["ssh", "sftp"]`, `sftpAuths = ["password", "key"]`, `remoteRootValue(raw) -> string | null` (absolute POSIX, normalised, no `..`, ≤ 1024 chars, no control characters).
- Produces: catalog host row fields `type` (absent = `"ssh"`), for SFTP `auth`, `remoteRoot`, `credentialRevision` (random UUID, never a password hash), `keyId: null` for password auth.
- Produces: `SshAccessStore.project()` adds `type`, `auth`, `remoteRoot`, `hasPassword`; `keyName/publicKey/fingerprint` are `null` without a key. `createAccess` accepts `type, auth, password, remoteRoot`; `updateAccess` accepts `password, remoteRoot, auth` and refuses a `type` change (`serverMessages.ssh.hostTypeFixed`, 409).
- Produces: `SshAccessStore.sftpConnection(id) -> { revision, host, port, username, hostKey, remoteRoot, password? , privateKey? }` (in-process only; key bytes read through `keyStore.openPrivate`, fd closed). `connection(id)` throws `sshProblem("SSH_HOST_TYPE", serverMessages.ssh.sftpOnly, 409)` for SFTP rows; `test(id)` on SFTP opens a session and `realpath(remoteRoot ?? ".")`.
- Revision: SSH rows keep today's `connectionRevision` digest unchanged; SFTP rows append `[type, auth, remoteRoot, credentialRevision]`.
- `hostTuple` appends `"sftp"` for SFTP rows (an SFTP host may share host/port/user with an SSH host; SSH tuples unchanged).
- SFTP hosts are created and edited in the owner UI only; MCP `ssh_register_host` keeps registering SSH hosts (a password must never pass through a CLI).

- [ ] **Step 1: Write the failing tests**: `ssh-password-store.test.js`: `writes 0600 inside 0700`, `refuses a symlinked file`, `refuses a file over 1024 bytes`, `removeOthers keeps only the current revision`. `sftp-host-store.test.js` (catalog in a temp data dir): `creates a password SFTP host` (`project()` has `type: "sftp"`, `auth: "password"`, `hasPassword: true`, and `JSON.stringify(list())` does not contain the password); `key SFTP host counts as a key user` (`keyStore.get(keyId).hosts` names it, key removal refused); `password change rotates credentialRevision and revision`; `rollback leaves no password file` (throw in `beforeCommit`); `remove deletes the password directory after commit`; `type cannot change` (409); `SSH and SFTP host may share endpoint`; `connection() refuses SFTP with SSH_HOST_TYPE`; `test() succeeds against the fixture and fails with a wrong password` (`serverMessages.ssh.connectionFailed`); `remoteRoot must be absolute without ..`; `SSH rows keep their revision` (revision of an SSH row created before the change equals today's digest). Backup: `host backup with credentials omits ssh/passwords`.
- [ ] **Step 2: Run** `node --test tests/unit/sftp-host-store.test.js tests/unit/ssh-password-store.test.js` — FAIL.
- [ ] **Step 3: Implement** the store and field rules. Password files are written before the catalog commit with `catalog.afterRollback(() => remove new revision)` and `catalog.afterCommit(() => removeOthers(...))`; removal uses `afterCommit(removeHost)`. Add `serverMessages.ssh` keys `passwordRequired`, `passwordNotAllowed`, `invalidRemoteRoot`, `hostTypeFixed`, `sftpOnly`, `invalidAuth` (DE and EN). `server/ssh.mjs` prints `sftpOnly` for an SFTP host.
- [ ] **Step 4: Run** the tests above plus `node --test tests/unit/ssh-access.test.js tests/unit/ssh-catalog.test.js tests/unit/ssh-key-store.test.js tests/unit/ssh-management.test.js` — PASS; `npm run i18n:confirm -- ssh` and commit the lock.
- [ ] **Step 5: Commit** `feat: store SFTP hosts and passwords in the SSH catalog`

### Task 3: Remote paths, local paths, excludes and transfer plans

**Files:**
- Create: `server/features/sftp/sftp-limits.js`, `server/features/sftp/sftp-remote-paths.js`, `server/features/sftp/sftp-excludes.js`, `server/features/sftp/sftp-plan.js`, `server/features/sftp/sftp-local.js`
- Test: `tests/unit/sftp-remote-paths.test.js`, `tests/unit/sftp-excludes.test.js`, `tests/unit/sftp-plan.test.js`, `tests/property/sftp-plan.property.test.js`, `tests/integration/sftp-local.test.js`

**Interfaces:**
- Consumes: `projectTarget(root, raw, { write, protectedRoots, lockToolConfig })` from `server/features/assistants/project-paths.js`; `sftpProblem`.
- Produces: `sftpLimits = { maxBytes: 2 * 1024 ** 3, maxFiles: 10000, maxScanEntries: 50000, scanMs: 60000, jobMs: 7200000, listEntries: 1000, pathChars: 4096, excludes: 50, excludeChars: 200, planListLimit: 500, resultListLimit: 200, mtimeToleranceMs: 2000, runningJobs: 2 }`.
- Produces: `remotePath(raw, base) -> string` (relative joins `base`; refuses NUL, control characters, `\`, > 4096 chars with `SFTP_PATH_REFUSED`; collapses `.`/`..` lexically and refuses climbing above `/`); `insideRoot(root, p) -> boolean`; `confineRemote(session, p, root) -> Promise<string>` (realpath of the deepest existing ancestor, joined with the missing names, must be inside `root`; `root === null` → returns `p`).
- Produces: `defaultExcludes = [".git", ".env"]`; `excludeList(patterns = [], { defaults = true }) -> string[]`; `excluded(relative, patterns) -> boolean` — a pattern without `/` matches any path segment, a pattern with `/` matches from the transfer root, `*`/`?` stay inside a segment, `**` spans segments; compiled once to linear regexes.
- Produces: `Entry = { path /* relative POSIX */, size, mtimeMs }`; `planTransfer({ source, target, sync = false, deleteExtra = false, hashes = null }) -> Plan`, `Plan = { create: Entry[], update: Entry[], delete: Entry[], unchanged, files, bytes, overwrites, deletes, digest }` — copy mode (`sync: false`) puts every source entry in create or update; sync updates on size difference, `|mtime| > mtimeToleranceMs`, or — when `hashes = { source: Map, target: Map }` is given — on hash difference only; `delete` is filled only with `sync && deleteExtra`; `digest` = SHA-256 of the canonical sorted plan.
- Produces: `capPlan(plan, limits = sftpLimits)` throws `SFTP_LIMIT` with `details: { files, bytes }`; `planSummary(plan, listLimit) -> { create: string[], update: string[], delete: string[], more: { create, update, delete }, files, bytes, overwrites, deletes }`.
- Produces: `localRoot({ root, raw, write, protectedRoots, lockToolConfig }) -> projectTarget result`; `walkLocal(target, { excludes, limits }) -> Promise<{ entries: Entry[], skipped: { links, special } }>` (lstat, never follows links, skips files with more than one link); `openLocalSource(target, relative) -> FileHandle` (`O_NOFOLLOW`, regular, one link, still inside the root); `writeLocal(target, relative, readable, { mtimeMs }) -> Promise<{ overwritten }>` (parents created one segment at a time with lstat checks, temp `.<name>.agentpier-part-<hex>` opened `O_CREAT|O_EXCL|O_NOFOLLOW`, rename, `utimes`; temp removed on error or abort).

- [ ] **Step 1: Write the failing tests**: remote paths — `relative joins the root`, `.. above / refused`, `newline refused`, `confineRemote refuses a symlink leaving the root` (fake session whose `realpath` maps `/www/link` to `/etc`). Excludes — `.git` excludes `a/.git/config`; `.env` excludes `.env` but not `.env.example`; `dist/*.map`; `**/cache`; `defaults: false`. Plan — `copy counts overwrites`; `sync skips equal size and mtime within 2 s`; `sync with hashes ignores mtime`; `delete empty without deleteExtra`; `capPlan rejects 10,001 files and 2 GiB + 1 byte`; `planSummary caps lists at 500 with more counts`. Property (fast-check) — create/update/unchanged partition the source; applying a plan to the target then re-planning yields empty create/update/delete; `deletes === 0` whenever `deleteExtra` is false; the digest changes when any entry changes. Local — `link out of the root is skipped`, `data dir refused as protected root`, `writeLocal leaves no temp file after an aborted stream`, `writeLocal into a read-only target refused` (`write: true` path through `projectTarget`).
- [ ] **Step 2: Run** `node --test tests/unit/sftp-*.test.js tests/property/sftp-plan.property.test.js tests/integration/sftp-local.test.js` — FAIL.
- [ ] **Step 3: Implement** the five modules with the signatures above.
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** `feat: plan SFTP transfers with excludes and confined paths`

### Task 4: Operations, transfer engine and background jobs

**Files:**
- Create: `server/features/sftp/sftp-operations.js`, `server/features/sftp/sftp-transfer.js`, `server/features/sftp/sftp-jobs.js`
- Test: `tests/integration/sftp-operations.test.js`, `tests/integration/sftp-transfer.test.js`, `tests/unit/sftp-jobs.test.js`

**Interfaces:**
- Consumes: Task 1 `SftpSession`, Task 3 modules.
- Produces (`sftp-operations.js`): `sftpList(session, abs, { limit }) -> { path, entries: [{ name, type, size, mtime /* ISO */ }], truncated }`; `sftpStat(session, abs) -> { path, type, size, mtime }`; `sftpMkdir(session, abs, { parents = false }) -> { path, created }`; `sftpRename(session, from, to) -> { from, to }` (refuses an existing target with `SFTP_TYPE_CONFLICT`); `planDelete(session, abs, { recursive = false, limits }) -> { path, files: string[], dirs: string[], bytes }` (non-recursive: one file or an empty folder; links are deleted as links, never followed); `runDelete(session, deletePlan, { signal, onProgress }) -> { files, dirs }`.
- Produces (`sftp-transfer.js`): `TransferRequest = { operation: "download"|"upload"|"sync", direction: "up"|"down", remotePath /* confined abs */, local /* localRoot result */, deleteExtra, checksum, excludes }`; `prepareTransfer(session, request, { limits, signal }) -> Prepared`, `Prepared = { request, kind: "file"|"folder", plan, summary, skipped }` (pre-scan of both sides within `scanMs`/`maxScanEntries`, `capPlan` before returning; checksum hashes only same-size pairs by streaming both sides); `runTransfer(session, prepared, { signal, onProgress, stillAuthorized }) -> Result`, `Result = { state: "completed"|"failed"|"cancelled"|"revoked", files, bytes, created, updated, deleted, overwritten: string[] /* ≤ resultListLimit */, skipped, failedPath?, code?, durationMs }`. Uploads write `<dir>/.<name>.agentpier-part-<hex>`, then `rename(..., { overwrite: true })`, then `setTimes(mtimeMs)`; downloads use `writeLocal`; deletes run after all copies, files before folders, deepest first, only paths in the plan. Stops at the first error (no retries) and removes its own temp file. `stillAuthorized()` is awaited before each file and every 2 s; `false` → `state: "revoked"`.
- Produces (`sftp-jobs.js`): `SftpJobs({ now = Date.now, limit = sftpLimits.runningJobs, keepMs = 3600000 })`: `start(owner, { kind, summary, run: (progress, signal) => Promise<Result> }) -> JobView` (throws `SFTP_BUSY` at `limit` running jobs per owner), `get(owner, id) -> JobView` (`SFTP_JOB_NOT_FOUND` for another owner), `cancel(owner, id) -> JobView`, `wait(owner, id, ms) -> Promise<JobView>`, `onProgress(callback)` (≤ 1 call per second per job), `closeAll()`. `JobView = { jobId, kind, state: "running"|"completed"|"failed"|"cancelled"|"revoked", progress: { files, filesDone, bytes, bytesDone, current }, result? }`; jobs end after `jobMs` as `failed` with `SFTP_TIMEOUT`.

- [ ] **Step 1: Write the failing tests** against `startSftpServer`: `folder upload creates folders and counts overwrites`; `folder download`; `sync up copies new and changed only`; `second sync is a no-op` (mtime preserved both ways); `deleteExtra removes target-only files and empty folders`; `default excludes keep .git and .env local`; `pre-scan over the file cap fails before writing` (`limits: { ...sftpLimits, maxFiles: 3 }`); `checksum finds same-size same-mtime change`; `symlinks are skipped and reported`; `remote root confinement`; `unusual names` (spaces, `ä`, leading `-` transfer; newline refused); `type conflict fails without deleting`; `dropped connection` (`dropAfterBytes`) leaves no part files and reports `failedPath`; `cancel mid-transfer` → `cancelled`, no part files; `stillAuthorized false stops before the next file`; operations: `list truncates at limit`, `rename refuses existing target`, `non-recursive delete refuses a non-empty folder`, `recursive delete removes a link, not its target`. Jobs: `limit per owner`, `other owner cannot read`, `progress throttled to 1/s` (fake clock), `job times out after jobMs`.
- [ ] **Step 2: Run** `node --test tests/integration/sftp-operations.test.js tests/integration/sftp-transfer.test.js tests/unit/sftp-jobs.test.js` — FAIL.
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** `feat: run SFTP transfers, syncs and deletes as cancellable jobs`

### Task 5: `sftp_*` tools for coding CLIs in the session MCP server

**Files:**
- Create: `server/features/sftp/sftp-session-tools.js`, `server/features/sftp/sftp-session-audit.js`
- Modify: `server/features/ssh/ssh-tools.js` (tool list, dispatch, `ssh_list_hosts` fields, `ssh_execute` refusal), `server/features/ssh/ssh-sessions.js` (`resolve` kind), `server/features/ssh/ssh-management.js` (`allowed.sftp_record`, dispatch only), `server/features/ssh/ssh-discovery.js` (hint names `sftp_*` tools when SFTP hosts exist), `server/features/audit/audit-schema.js` (resource `sftp`), create `server/features/audit/audit-sftp-details.js`, `web/features/ssh/SshChoices.jsx` + `web/features/ssh/SessionSshDialog.jsx` (SFTP badge in the session host picker)
- Test: `tests/integration/sftp-session-tools.test.js`, update `tests/unit/ssh-tools.test.js`, `tests/unit/ssh-mcp.test.js`, create `tests/unit/audit-sftp-details.test.js`

**Interfaces:**
- Consumes: `store.sftpConnection` (Task 2); Tasks 3–4.
- Produces: `sftpTools` (MCP definitions, all `additionalProperties: false`, `accessId` required): `sftp_list {accessId, remotePath?}`, `sftp_stat {accessId, remotePath}`, `sftp_download {accessId, remotePath, localPath?, exclude?, defaultExcludes?, dryRun?}`, `sftp_upload {accessId, localPath, remotePath, exclude?, defaultExcludes?, dryRun?}`, `sftp_sync {accessId, direction: "up"|"down", localPath?, remotePath, deleteExtra?, checksum?, exclude?, defaultExcludes?, dryRun?}`, `sftp_mkdir {accessId, remotePath, parents?}`, `sftp_rename {accessId, remotePath, toPath}`, `sftp_delete {accessId, remotePath, recursive?}`, `sftp_job {jobId, cancel?}`. Paths are strings ≤ 4096, `exclude` ≤ 50 strings ≤ 200.
- Produces: `SftpSessionTools({ dataDir, capability, grants, store, manage })`: `call(name, input) -> object`, `close()` (cancels jobs). Local root = `validateSshProjectBinding(session.sshTools.project).launch.path`, `protectedRoots: [dataDir]`. Transfers wait up to 20 s, then return `{ status: "running", jobId, progress }`; finished: `{ status, ...Result, summary }` with lists capped at `resultListLimit`; `dryRun` returns `{ status: "planned", summary }`.
- Produces: `SshSessions.resolve(sessionId, accessId, { type = "ssh" } = {})` returns `store.connection` or `store.sftpConnection`; a type mismatch throws `SSH_HOST_TYPE`.
- Produces: management method `sftp_record` with fields `["accessId", "operation", "state", "files", "bytes", "deleted", "durationMs", "remotePath", "localPath", "code"]`, handled by `recordSessionSftp(management, context, input)`: checks the host is in the session's effective grants, appends `sftp.completed` / `sftp.failed` (`resourceType: "ssh"`, `source: "mcp"`). Called best-effort by `SftpSessionTools` after every transfer and write (not for list/stat/job).
- Produces: `sftpAuditDetails(details, event, auditId)` (ids, `operation ∈ {download, upload, sync, mkdir, rename, delete}`, `direction`, counts and bytes as safe integers, `durationMs`, `remotePath`/`localPath` ≤ 1024 chars without control characters, `code` matching `/^S(SH|FTP)_[A-Z_]{2,40}$/`); audit actions `sftp.completed`, `sftp.failed`, `sftp.denied`.

- [ ] **Step 1: Write the failing tests** (`tests/helpers/ssh-management.js` + `startSftpServer`, a temp session project folder): `ssh_list_hosts reports type and remoteRoot`; `ssh_execute on an SFTP host returns SSH_HOST_TYPE`; `sftp_upload of a project folder`; `localPath outside the project refused`; `sftp_download into the project`; `sftp_sync dryRun lists deletes without changing anything`; `revoking the grant stops a running job`; `sftp_job reports progress and cancels`; `no tool result contains the password` (stringify every result); `writes are audited by the application with source mcp` (audit row present, no password, no file contents); `ssh-tools lists sftp tools`; audit details unit tests drop unknown keys and control characters.
- [ ] **Step 2: Run** `node --test tests/integration/sftp-session-tools.test.js tests/unit/ssh-tools.test.js tests/unit/ssh-mcp.test.js tests/unit/audit-sftp-details.test.js` — FAIL.
- [ ] **Step 3: Implement** the tool class, dispatch (`name.startsWith("sftp_")`), resolve kind, management dispatch, audit details and the picker badge. If the nono sandbox grant set (`ssh-integration.js`) does not already allow reading `node_modules/ssh2`, add a read grant next to `main`.
- [ ] **Step 4: Run** the same command plus `node --test tests/integration/ssh-management-stdio.test.js tests/unit/ssh-integration.test.js` — PASS.
- [ ] **Step 5: Commit** `feat: give coding sessions sftp tools on granted hosts`

### Task 6: Agent SFTP actions (reads and trusted writes)

**Files:**
- Create: `server/features/assistants/agent-sftp.js`, `server/features/assistants/agent-sftp-policy.js`, `server/features/assistants/agent-sftp-input.js`, `server/features/assistants/agent-sftp-local.js`
- Modify: `server/features/assistants/agent-ssh.js` (dispatch, `hosts()` fields, `execute` refusal, `close()` closes jobs), `server/features/assistants/team-plugin/ssh-tool.js` (schema and description), `server/features/assistants/tool-errors.js`, `server/features/assistants/assistant-action-store.js` (`pruneTrustedSsh` → `pruneTrusted(assistantId, action, keep)`), `tests/helpers/agent-ssh-fixture.js` (`fakeCatalog` gains `sftpConnection(id)` and SFTP rows)
- Test: `tests/unit/agent-sftp-policy.test.js`, `tests/unit/agent-sftp-input.test.js`, `tests/integration/assistant-sftp-trusted.test.js`, update `tests/unit/assistant-ssh-plugin.test.js`, `tests/unit/agent-ssh-tool-errors.test.js`, `tests/integration/assistant-ssh-runtime-contract.test.js`

**Interfaces:**
- Consumes: Tasks 2–4; `AgentSsh.caller/classify/host/refuse/audit/problem`; `workspaceContext(w, inv)` and `w.folders.levels(ctx)`; `w.a.config.writeGuard()`.
- Produces: `agentpier_ssh` actions `hosts`, `execute` (unchanged) plus `list`, `stat`, `download`, `upload`, `sync`, `mkdir`, `rename`, `delete`, `job`, `cancel`; new properties `remotePath`, `toPath`, `localPath`, `projectId` (local root: a granted project folder; absent = the agent's workspace `path.join(attachments.config.workspaces, assistantId)`), `direction` (`up`|`down`), `deleteExtra`, `checksum`, `recursive`, `parents`, `exclude`, `defaultExcludes`, `dryRun`, `jobId`. `hosts` entries add `type` and `remoteRoot`.
- Produces: `sftpKind(action, input) -> "read"|"write"|"delete"` (`list`, `stat`, `download`, `sync` down without `deleteExtra` → read; `upload`, `mkdir`, `rename`, `sync` up without deletes → write; `delete`, any `sync` with `deleteExtra` → delete); `sftpPermits(mode, cls, kind) -> "run"|"card"|"refuse"`: refused class → refuse; routine → `routines` mode and not delete → run, else refuse; owner/delegated → read run, write card in `approval` and run otherwise, delete card.
- Produces: `sftpInput(input) -> normalized` (per-action required fields, 400 `invalid` otherwise); `agentLocalRoot(w, inv, { projectId, write }) -> { root, protectedRoots, lockToolConfig, projectId, projectName }` (project read level for uploads, write level + routine "May write" + `writeGuard()` for downloads and sync down; `projectFolderNotGranted`/`projectFolderReadOnly`/`projectWriteUnavailable` errors as in `agent-project-files.js`).
- Produces: `AgentSftp(ssh, { approvals })`: the `card` verdict calls `approvals.request(inv, caller, cls, host, request, prepared)`; until Task 7 the default `approvals.request` throws `assistantProblem("invalid", 503)`. Methods `invoke(inv, input)`, `run({ caller, cls, mode, host, request, prepared, authorizedBy, actionId? }) -> Result`, `jobs: SftpJobs`. Every transfer and write reserves one action row `{ payload: { action: "sftp", trusted: true|false, operation, accessId, hostName, remotePath, toPath?, local: { projectId, projectName, path }, direction?, summary, originClass }, state: "executing", chatNotes: { started } }`, patched with `result.progress` (via `SftpJobs.onProgress`, ≤ 1/s, then `w.a.changed({ conversationId })`) and settled with `Result`; `pruneTrusted(assistantId, "sftp", 500)`. The call waits until `inv.startedAt + sshHoldMs`; then it returns `{ status: "running", jobId: actionId, progress }` and marks `followUp`. `job` reads the row (after a restart `unknown`); `cancel` aborts the job of that row for the same agent. `list`/`stat` run inline and leave no row and no audit.
- Produces: tool-error texts for `SSH_HOST_TYPE` and every `SFTP_*` code of Task 1 (agent-facing English, tell the agent what to do).
- Produces: audit `sftp.completed` / `sftp.failed` / `sftp.denied` (`resourceType: "ssh"`) with `assistantId`, `originClass`, `authorizedBy`, `mode` and Task 5's details.

- [ ] **Step 1: Write the failing tests**: policy table covering every `(mode, cls, kind)`; input validation (missing `remotePath`, unknown keys, `exclude` of 51 entries); integration with `workflowFixture` + `startSftpServer`: `list and stat run in approval mode without a card`; `download into a read-only project is refused`; `trusted upload runs and leaves one row and one audit event`; `trusted mode never runs a delete directly` (the call rejects and the remote file still exists); `routine with routines mode uploads; delete refused`; `execute on an SFTP host returns SSH_HOST_TYPE`; `file action on an SSH host returns SSH_HOST_TYPE`; `long upload returns running with jobId and job reports progress`; `cancel stops the job`; `host edit stops a running job` (revision change between files → `revoked`); `temporary member uses lead's SFTP grant only while shell and SSH are shared`; `no result, row or audit contains the password`.
- [ ] **Step 2: Run** `node --test tests/unit/agent-sftp-policy.test.js tests/unit/agent-sftp-input.test.js tests/integration/assistant-sftp-trusted.test.js` — FAIL.
- [ ] **Step 3: Implement** the modules and wiring; keep `agent-ssh.js` under 600 lines by keeping all SFTP logic in `agent-sftp*.js`.
- [ ] **Step 4: Run** the tests above plus `node --test tests/integration/assistant-ssh-*.test.js tests/unit/agent-ssh-*.test.js tests/unit/assistant-ssh-plugin.test.js` — PASS.
- [ ] **Step 5: Commit** `feat: let agents read and transfer files on granted SFTP hosts`

### Task 7: Agent SFTP approvals, "Always allow" and Telegram

**Files:**
- Create: `server/features/assistants/agent-sftp-approvals.js`, `server/features/assistants/agent-sftp-grants.js`, `server/features/assistants/agent-sftp-notifications.js`
- Modify: `server/features/assistants/agent-sftp.js` (card branch), `server/features/assistants/assistant-workflows.js` (decide kind, `sftpDecisions`, Telegram gate, `advance` dispatch, `pending()` includes executing `sftp`), `server/features/assistants/agent-ssh-origin.js` (`sftp-result` like `ssh-result`), `server/features/assistants/agent-ssh.js` (`classify` reads `payload.action ∈ {ssh, sftp}`; `revokeAccess` also cancels SFTP cards), `server/features/assistants/assistant-access.js` (export `approvalRevision` only), `server/features/audit/audit-ssh-details.js` (reason `always-allow`), `server/features/assistants/assistant-action-notifications.js` (dispatch to `notifySftp`), `server/features/inbox/inbox-items.js` (title), `server/lib/i18n/{de,en}/assistants.js`, `server/lib/i18n/translation-lock.json`
- Test: `tests/integration/assistant-sftp-approvals.test.js`, `tests/unit/agent-sftp-notifications.test.js`, update `tests/unit/agent-ssh-origin.test.js`

**Interfaces:**
- Consumes: Task 6 `AgentSftp.run`, `prepareTransfer`, `planDelete`; `sshApprovalMs`, `sshHoldMs` from `agent-ssh-approvals.js`.
- Produces: `sftpDecisions = ["approve", "allow-always", "decline"]`, `maxOpenSftpApprovals = 3`; `SftpApprovals(sftp)`: `request(inv, caller, cls, host, request, prepared)`, `decide(action, decision)`, `advance(action)`, `cancelFor(accessId)`. Card payload adds to Task 6's row payload: `host, port, username, hostFingerprint, projectId, projectName, deleteExtra, checksum, excludes, summary` (`planSummary`, lists ≤ 500), `planDigest`, `deletes`, `allowAlways: deletes === 0`, `connectionRevision`, `expiresAt`; `trusted: false`; state `awaiting_approval`, key `sftp:<attemptId>:<toolCallId>`.
- Decide: `decline` → declined; `allow-always` with `deletes > 0` → 400 `invalid`; otherwise `alwaysAllowSftp` first; both then run the SSH stale check (holder, grant, host present, `revision === connectionRevision` else `ACCESS_CHANGED`/`HOST_REMOVED`), set `executing`, re-run `prepareTransfer`/`planDelete` and compare digests (`SFTP_PLAN_CHANGED` → `failed`, nothing written), then `AgentSftp.run(... authorizedBy: "approval")`. Expiry, restart (`executing` without a job → `unknown`) and the `sftp-result` follow-up (`clientRequestId: "sftp-result:<id>"`, origin `{ kind: "sftp-result", actionId }`) follow `SshApprovals`.
- Produces: `alwaysAllowSftp(access, holderId, accessId) -> boolean` — sets that grant from `approval` to `trusted` (leaves `trusted`/`routines` alone), writes with `revision + 1` and `approvalRevision(before)` like `revokeEach`, audits through `access.auditSsh(holderId, before, after, "always-allow")`, calls `s.assistants.changed()`.
- Produces: `notifySftp(w, action, phase, key, m, target)` and `sftpTelegramApprovable(payload) -> boolean` (no `more` paths, ≤ 20 paths per list, no hidden characters per `hasHiddenCharacters`); Telegram buttons `approve` (`m.sftpAllowOnce`), `allow-always` (`m.sftpAllowAlways`, only with `allowAlways`), `decline` (`m.sftpDeny`); otherwise `m.sftpOpenToApprove`. Text: agent, requested by, `user@host:port`, operation, remote path, local path, counts new/changed/deleted, size, overwrites, the paths.

- [ ] **Step 1: Write the failing tests**: `approval-mode upload creates a card with files, bytes and overwrites`; `allow once runs it`; `allow-always switches the grant to trusted and the next upload runs without a card` (audit `ssh-grants` with `modeChanged` and reason `always-allow`); `delete asks even in trusted mode`; `allow-always is refused on a card with deletes`; `deny writes nothing`; `plan changed between card and approval fails with SFTP_PLAN_CHANGED`; `edited host cancels the card` (`ACCESS_CHANGED`); `removed host cancels open SFTP cards`; `a fourth open card is refused`; `result after the hold arrives as sftp-result follow-up and is classified with the inherited origin`; `card payload, Telegram text and audit never contain the password`; notifications unit: buttons present/absent per `allowAlways` and `sftpTelegramApprovable`, DE and EN texts.
- [ ] **Step 2: Run** `node --test tests/integration/assistant-sftp-approvals.test.js tests/unit/agent-sftp-notifications.test.js tests/unit/agent-ssh-origin.test.js` — FAIL.
- [ ] **Step 3: Implement**; `assistant-workflows.js` stays under 600 lines (only dispatch lines there). Pass `SftpApprovals` into `AgentSftp`; Task 6's delete test now sees a card.
- [ ] **Step 4: Run** the tests above plus `node --test tests/integration/assistant-ssh-approvals.test.js tests/integration/assistant-ssh-revocation.test.js tests/integration/assistant-telegram-senders-ssh.test.js` — PASS; `npm run i18n:confirm -- assistants`.
- [ ] **Step 5: Commit** `feat: ask the owner before agents write to SFTP hosts`

### Task 8: SFTP hosts in settings and the agent Work tab

**Files:**
- Create: `web/features/ssh/SftpCredentialFields.jsx`
- Modify: `web/features/ssh/SshAccessForm.jsx`, `web/features/ssh/SshAccessDetails.jsx`, `web/features/ssh/SshResourceList.jsx` (type badge), `web/features/assistants/settings/SshGrantPage.jsx` (SFTP mode copy), `web/lib/i18n/{de,en}/ssh.js`, `web/lib/i18n/{de,en}/assistant-ssh.js`, `web/lib/i18n/translation-lock.json`
- Test: `tests/browser/sftp-settings.spec.js`, update `tests/browser/ssh-fixture.js` if it mocks `/ssh-accesses`

**Interfaces:**
- Consumes: Task 2 HTTP fields on `POST/PATCH /api/ssh-accesses` (`type`, `auth`, `password`, `remoteRoot`, `keyId`) and `project()` fields (`type`, `auth`, `remoteRoot`, `hasPassword`).
- Produces: host form with `Segmented` **Type** (SSH / SFTP; fixed when editing); for SFTP `Segmented` **Sign-in** (Password / Key), a password input (`type="password"`, `autoComplete="new-password"`, empty on edit with the hint "Saved. Enter a new password to replace it."), optional **Allowed remote folder**; host key fetch and fingerprint confirmation unchanged; **Test connection** for SFTP hosts. Lists show an "SFTP" badge and the remote folder. The Work tab's SFTP host modes read: With approval — "Reading runs, every change asks"; Trusted — "Changes run without asking, deletes always ask"; Trusted incl. routines — the same in routines.

- [ ] **Step 1: Write the failing browser test** (`--project` Chromium, English): `adds a password SFTP host` (request body has `type: "sftp"`, `auth: "password"`, the password; Save disabled until the fingerprint is confirmed; the list shows the SFTP badge); `edit form never shows the saved password`; `key sign-in offers saved keys`; `test connection reports success`; `Work tab shows SFTP mode texts`.
- [ ] **Step 2: Run** `npx playwright test tests/browser/sftp-settings.spec.js` (after `npm run build`) — FAIL.
- [ ] **Step 3: Implement** with existing components only (`Segmented`, `ListRow`, `Modal`, `.badge`); German and English keys together.
- [ ] **Step 4: Run** the spec plus `npx playwright test tests/browser/ssh-settings.spec.js tests/browser/assistant-ssh-work.spec.js`, `node --test tests/unit/ui-guide-rules.test.js` and the catalog parity tests — PASS; `npm run i18n:confirm -- ssh assistant-ssh`.
- [ ] **Step 5: Commit** `feat: manage SFTP hosts in settings`

### Task 9: Approval card and live activity rows in the agent chat

**Files:**
- Create: `server/features/assistants/agent-sftp-notes.js`, `web/features/assistants/sftp-run-note.js`, `web/features/assistants/SftpRunNote.jsx`, `web/features/assistants/SftpApprovalCard.jsx`, `web/lib/i18n/{de,en}/assistant-sftp.js`, `web/lib/i18n/messages/assistant-sftp.js`
- Modify: `server/features/assistants/assistant-action-notifications.js` (`actionNotes` dispatch), `web/features/assistants/AssistantActionApprovals.jsx`, `web/features/assistants/TranscriptItem.jsx`, `web/features/assistants/useAssistantActions.js` (executing `sftp`), `web/features/assistants/settings/ActionHistory.jsx`, `web/lib/i18n/translation-lock.json`
- Test: `tests/unit/sftp-run-note.test.js`, `tests/unit/agent-sftp-notes.test.js`, `tests/browser/assistant-sftp-chat.spec.js`

**Interfaces:**
- Consumes: `ActivityRow`, `StatusChip`, `formatBytes(bytes, locale)` from `web/features/artifacts/artifact-presentation.js` (move to `web/lib/` if imported across features), Task 6/7 rows.
- Produces: `sftpNotes(action) -> Note[]` — one note `{ id: "sftp-run:<id>", role: "event", event: "sftp-run", hostName, operation, direction, remotePath, toPath, localPath, state, progress, result, timestamp, memberName? }` from `chatNotes.started` on, updated in place until settled; denied/expired/cancelled cards leave none.
- Produces: `sftpRunView(note, locale) -> { icon: "upload"|"download"|"folder"|"trash", label, detail, status, tone, facts: [[label, value]] }` (running: "42 % · 12 of 124 files"; done: counts and bytes; failed: code and `failedPath`), `sftpHistoryText(action)`.
- Produces: `SftpApprovalCard({ action, decide })` — operation, `user@host:port`, fingerprint, remote path, local path, counts new/changed/deleted, size, overwrites, path lists in a disclosure with "+N more", deletes marked; buttons **Allow once**, **Always allow for this host** (only with `payload.allowAlways`), **Deny**.

- [ ] **Step 1: Write the failing tests**: notes unit (`started note while executing`, `settled note carries counts`, `declined card leaves no note`); view unit (DE/EN, progress text, tones); browser (English, `assistant-ssh-fixture.js` pattern): `card shows summary and three buttons`, `delete card has no Always allow`, `running row updates its progress and ends done`, `expanded row shows paths, bytes and duration`, `Work tab history line`.
- [ ] **Step 2: Run** `node --test tests/unit/sftp-run-note.test.js tests/unit/agent-sftp-notes.test.js` and `npx playwright test tests/browser/assistant-sftp-chat.spec.js` — FAIL.
- [ ] **Step 3: Implement**; the card follows `SshApprovalCard` layout and the UI guide.
- [ ] **Step 4: Run** the tests above plus `npx playwright test tests/browser/assistant-ssh-chat.spec.js` and `node --test tests/unit/ui-guide-rules.test.js` — PASS; `npm run i18n:confirm -- assistant-sftp`.
- [ ] **Step 5: Commit** `feat: show SFTP approvals and transfers as chat activity`

### Task 10: Documentation and final check

**Files:**
- Create: `docs/sftp-access.md`
- Modify: `docs/ssh-access.md` (link, SFTP hosts in **Scope and storage** and **Agents**), `docs/README.md` (index row), `docs/agents.md` (Work → SSH accesses: SFTP modes, approvals), `docs/assistant-gateway.md` (`agentpier_ssh` SFTP actions, limits, follow-up), `docs/architecture.md` (SSH paragraph), `README.md`, `README.de.md` (feature lists)
- Delete: `docs/superpowers/plans/2026-10-23-sftp-access.md`, `docs/superpowers/specs/2026-10-23-sftp-access-design.md` (before opening the PR)

**Interfaces:**
- `docs/sftp-access.md` covers: adding an SFTP host (Hetzner example: SFTP on port 22 with the main FTP user, not SSH port 222), password vs. key, fingerprint check, allowed remote folder, CLI tools and their schemas, agent actions, approvals and "Always allow" (revoke in the Work tab), deletes always ask, sync rules (size + mtime within 2 s, checksum, `deleteExtra`, default excludes), limits, jobs and cancel, storage (`ssh/passwords`, 0600, unencrypted at rest like keys, omitted from every backup), audit fields, and the downgrade note: a release without SFTP cannot read a catalog holding a password SFTP host — remove SFTP hosts before downgrading.

- [ ] **Step 1: Write** the docs; quote UI labels exactly as in the EN catalogs.
- [ ] **Step 2: Run** `npm run check` and `npm test` — PASS.
- [ ] **Step 3: Commit** `chore: document SFTP access`; delete plan and spec in the last commit before the PR (`chore: remove SFTP plan and spec`).
