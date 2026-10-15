# MCP Package Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the deferred review follow-ups of the managed MCP package installs (AGENTPIER-77 and AGENTPIER-79) in one hardening pull request, including three owner decisions: a "choose program" state after a build, immediate cancellation of a running install when its server is deleted, and the owner's custom CA for uv.

**Architecture:** The work stays inside `server/features/mcp-packages/` (service, jobs, adapters, records), its HTTP routes, the package UI in `web/features/mcp-servers/` and the docs. Two new server modules carry the new mechanisms: `child-process-tree.js` (npm/uv run in their own process group so a cancel ends the whole tree) and `uv-certificates.js` (Node's trust store plus `NODE_EXTRA_CA_CERTS` as one `SSL_CERT_FILE` bundle for uv). A third, `program-choice.js`, activates a program after a multi-program build without a rebuild. Everything else is small, local fixes grouped by area.

**Tech Stack:** Node.js 22.13+ ES modules, Express, `node:sqlite` (`DatabaseSync`), `node:test` + `node:assert/strict`, Playwright, React (JSX), uv 0.12.21, npm 11.

**Spec:** Plane tickets AGENTPIER-77 ("Harden MCP package installs: deferred review follow-ups") and AGENTPIER-79 ("PyPI MCP packages: deferred review follow-ups") plus the owner decisions quoted under Global Constraints. There is no separate spec document; the ticket items are mapped to tasks in "Ticket coverage" below.

## Global Constraints

- Branch `feat/mcp-packages-hardening`, worktree `.worktrees/mcp-packages-hardening`; never push to `main`; no merge commits.
- Commit messages in English with the history's prefixes (`fix:`, `feat:`, `test:`, `docs:`, `chore:`), each ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Every UI text change keeps `web/lib/i18n/de/` and `web/lib/i18n/en/` in step (same keys, same interpolation arguments); every new server message gets `server/lib/i18n/de/mcp-packages.js` **and** `server/lib/i18n/en/mcp-packages.js` entries; German server texts must be unique (they are identified by text).
- Source and test files checked by `check:structure` stay at or below 600 lines.
- Prettier: two spaces, double quotes, semicolons, trailing commas, 90 columns. Run `npx prettier --write <files>` on every file a task touches.
- Owner decision 1 (binding): a build with several programs stays at a "choose program" state in the status panel offering the found programs; choosing activates the server **without a rebuild**. Needs a new status, API route, i18n de+en, UI, tests.
- Owner decision 2 (binding): deleting a server during a running install cancels the running npm/uv process **immediately** and cleans up the stage (AbortController plus a kill of the child process tree; tests).
- Owner decision 3 (binding): pass the same CA the owner configured for Node (`NODE_EXTRA_CA_CERTS`) to uv via `SSL_CERT_FILE`, as a combined bundle with the trusted roots; update `docs/installation.md` (it currently says uv ignores it).
- EXCLUDED: the "literal audit action guard" unit test of AGENTPIER-79 (done in AGENTPIER-78 on another branch). New audit action literals in this plan must still pass `auditAction()` (`package.activated` does: resource `package`, verb `activated`).
- Tests never touch real user sessions or the default tmux server; gated real-uv tests run only with `AGENTPIER_MCP_PYTHON_TESTS=1`.
- Docs to keep true: `docs/mcp.md`, `docs/installation.md`, `docs/mcp-package-qualification.md` (only if a behaviour it records changes).

## Review Focus

1. **Delete during the switch window.** A server deleted while its job is inside `activate()` (after the install, during `changes.update` or its `onSaved`) must not leave a package record behind or resurrect the server; the restore of the previous record in `activate()` must be skipped once cancelled. Test: Task 2, "a cancel during the command switch restores no record".
2. **Process-group reuse.** `runProcessTree` kills `-pid` only while the run is being stopped (abort, timeout, buffer overflow), never after a normal exit, so a reused process-group id is never signalled. Test: Task 1, "a finished run signals no process group".
3. **Old databases.** A data dir created before this PR (old `CHECK(status IN (...))`, possibly missing `constraints`/`needs_scripts`) must open, keep its rows and accept `choosing`; a failure mid-migration must leave the old table intact. Test: Task 5, migration tests.
4. **CA bundle edge cases.** `NODE_EXTRA_CA_CERTS` unset, missing, a directory, larger than 1 MiB or without any PEM block must leave uv on its own roots (no `SSL_CERT_FILE`) and never log the path. Test: Task 12, "an unusable extra CA file leaves uv on its own roots".
5. **Choose program after a restore or a deleted install.** A `choosing` record whose install directory vanished reports `missing` (Reinstall shown), and choosing a program for it is refused instead of activating a missing script. Test: Task 6, "a choosing record without its install is missing and refuses a choice".

---

## Ticket coverage

| Ticket item                                                             | Task                    |
| ----------------------------------------------------------------------- | ----------------------- |
| 77 cancel a running install job when its server is deleted (decision 2) | 1, 2                    |
| 77 restored row in `installing` without a job shows "Installing…"       | 4                       |
| 77 unwrapped SQLite errors in attach/detach/start                       | 3, 4                    |
| 77 theoretical storedLeading revision race                              | 4                       |
| 77 a losing concurrent attach consumes its preview                      | 3                       |
| 77 takePreview consumes the preview before program/scripts checks       | 3                       |
| 77 Object.hasOwn in npmVersionInfo                                      | 8                       |
| 77 pin redirects in fetchRegistryJson to the registry host              | 8                       |
| 77 full sha512 base64 shape check in the lock                           | 8                       |
| 77 compare installed package name, not only version                     | 8                       |
| 77 cleanup must not follow a symlinked install dir                      | 8                       |
| 77 normalise pendingCommand in the store                                | 5                       |
| 77 N+1 receipt reads per packaged row                                   | 5                       |
| 77 UI: dependency path for nested duplicates                            | 14                      |
| 77 UI: clear the version when the package name changes                  | 14                      |
| 77 UI: update confirmation lacks returnKey                              | 14                      |
| 77 UI: detach → keep package leaves a no-op dirty draft                 | 14                      |
| 77 UI: placeholder literal                                              | 14                      |
| 77 UI: `#f0b9ab` → `--error-text` (accounts.css, mcp-servers.css)       | 14                      |
| 77 tests: scoped-name URL encoding                                      | 8                       |
| 77 tests: matcher for assert.throws in package records                  | 5                       |
| 77 tests: null-command OpenClaw compile case                            | 15                      |
| 77 tests: null-toolchain prune assertion                                | 15                      |
| 77 tests: non-object source / `source: null` route cases                | 15                      |
| 77 tests: attach without edits skips the revision check                 | 15                      |
| 77 tests: toolchain-level unsupported-arch and glibc option tests       | 15                      |
| 77 tests: packageCode and verified-files edge cases                     | 15                      |
| 77 shared Node checksum object frozen only shallowly                    | 15                      |
| 79 program choice for sdist-only packages with several scripts (dec. 1) | 5, 6, 7                 |
| 79 preview failures give a short reason instead of "see the log"        | 11                      |
| 79 custom CA for uv (decision 3)                                        | 12                      |
| 79 128-char cap in the PyPI version list filter                         | 9                       |
| 79 PEP 440 tie-break ordering                                           | 9                       |
| 79 pypiProject validates its name                                       | 9                       |
| 79 watch the deprecated `releases` key                                  | 9                       |
| 79 bound the stored integrity string                                    | 9                       |
| 79 real-zip tests for the wheel reader                                  | 10                      |
| 79 refuse a symlinked dist-info dir                                     | 10                      |
| 79 deterministic dist-info choice                                       | 10                      |
| 79 test that a rejected preview frees its slot                          | 3                       |
| 79 distinguish "no wheels" from other resolve errors                    | 11                      |
| 79 reject `x==1.0a1.*` constraints at validation                        | 10                      |
| 79 ALTER + backfill in one transaction                                  | 5                       |
| 79 start-time reconcile respects the maintenance guard                  | 4                       |
| 79 audit specifier length                                               | 13                      |
| 79 retry for the pinned setuptools download in the gated build test     | 15                      |
| 79 literal audit action guard test                                      | EXCLUDED (AGENTPIER-78) |

No item is skipped. Two items are interpreted narrowly and say so in their task: "watch the deprecated `releases` key" becomes a detection that fails loudly (registry unavailable plus one log line) instead of silently listing no versions; "attach without edits skips the revision check" is pinned as intended behaviour by a test (the attach itself writes only the package record; the later command switch re-reads the revision).

## File Structure

New files:

- `server/features/mcp-packages/child-process-tree.js` — `runProcessTree(file, args, options)`: execFile-compatible runner in its own process group; abort/timeout/overflow end the group.
- `server/features/mcp-packages/program-choice.js` — `choosablePrograms(service, id)` and `chooseInstalledProgram(service, id, wanted)` for the `choosing` state.
- `server/features/mcp-packages/pep440.js` — `comparePep440(a, b)`.
- `server/features/mcp-packages/uv-certificates.js` — `uvCertificateFile(work, environment, options)`.
- `web/features/mcp-servers/McpPackageProgramChoice.jsx` — the program select + activate button of the panel.
- `web/features/mcp-servers/mcp-package-labels.js` — `showsPath(entry, list)` and `refusalField(error, registry)`.
- `tests/helpers/mcp-packages-harness.js` — the in-memory service harness moved out of `tests/unit/mcp-packages-service.test.js` (that file is at 516 lines).
- `tests/helpers/zip-file.js` — `zipBytes(entries)`: a stored zip for real wheel-reader tests.
- Tests: `tests/unit/mcp-process-tree.test.js`, `tests/unit/mcp-package-cancel.test.js`, `tests/unit/mcp-package-previews.test.js`, `tests/unit/mcp-package-state.test.js`, `tests/unit/mcp-package-records-migration.test.js`, `tests/unit/mcp-program-choice.test.js`, `tests/unit/mcp-pep440.test.js`, `tests/unit/mcp-wheel-zip.test.js`, `tests/unit/mcp-uv-certificates.test.js`, `tests/unit/mcp-package-labels.test.js`, `tests/integration/mcp-packages-cancel.test.js`.

Modified (main ones): `install-jobs.js`, `package-install-job.js`, `mcp-packages.js`, `npm-package-install.js`, `python-package-install.js`, `npm-adapter.js`, `python-adapter.js`, `package-records.js`, `package-store.js`, `package-errors.js`, `package-spec.js`, `lock-check.js`, `registry-metadata.js`, `wheel-programs.js`, `toolchain-manifest.js`, `server/features/operations/release-download.js`, `server/features/mcp-servers/mcp-server-store.js`, `server/features/audit/audit-schema.js`, `server/http/routes/mcp-packages.js`, `server/http/routes/mcp-servers.js`, `server/lib/i18n/{de,en}/mcp-packages.js`, `web/features/mcp-servers/{McpPackagePanel,McpPackageConfirmation,McpPackageFields,McpServerFields,McpServerDetail}.jsx`, `web/features/assistants/assistant-api.js`, `web/lib/i18n/{de,en}/mcp-packages.js`, `web/features/accounts/accounts.css`, `web/features/mcp-servers/mcp-servers.css`, `docs/mcp.md`, `docs/installation.md`.

Interfaces fixed across tasks (later tasks rely on these exact names):

- `PackageJobs.run(serverId, { kind, installId }, work)`; `work(log, note, signal)`; `PackageJobs.cancel(serverId) → Promise<boolean>`; job states `running | done | failed | cancelled`.
- `McpPackages.cancel(id) → Promise<boolean>`; `McpPackages.peekPreview(previewId, source)`; `McpPackages.consumePreview(previewId)`; `McpPackages.chooseProgram(id, wanted) → job snapshot`.
- `activate(service, serverId, fields, command, leading, { signal } = {})`; `service.switching` entries `{ before, after, command, leading }`; `switchedTo(server, switching) → boolean`.
- `PackageRecords#orphaned(serverId) → boolean` (hook, default `() => false`); `PackageRecords#byServer() → Map<serverId, row>`; `publicFields(serverId, rows?)`, `definitionFields(serverId, rows?)`.
- Record status values: `installing | ready | failed | choosing`; computed status adds `missing`.
- Receipt field `programs: [{ name, path }]` (present when the adapter names programs after install).
- New codes: `MCP_PACKAGE_CANCELLED` (key `cancelled`), `MCP_PACKAGE_UNSATISFIABLE` (key `unsatisfiable`); new message key `previewFailed` for `MCP_PACKAGE_INSTALL_FAILED`.
- `GET /api/mcp-servers/:id/package` adds `programs: string[]`; new `POST /api/mcp-servers/:id/package/program` with `{ program }` → `202 { job }`, audited as `package.activated`.

---

### Task 1: Process-tree runner for npm and uv

**Files:**

- Create: `server/features/mcp-packages/child-process-tree.js`
- Modify: `server/features/mcp-packages/package-errors.js` (add `MCP_PACKAGE_CANCELLED`)
- Modify: `server/lib/i18n/de/mcp-packages.js`, `server/lib/i18n/en/mcp-packages.js` (key `cancelled`)
- Test: `tests/unit/mcp-process-tree.test.js`, `tests/unit/mcp-package-errors.test.js`

**Interfaces:**

- Produces: `runProcessTree(file, args, { cwd, env, timeout = 0, maxBuffer = 1024 * 1024, signal, graceMs = 5000 }) → Promise<{ stdout, stderr }>`; rejects with `MCP_PACKAGE_CANCELLED` (plus `stdout`/`stderr`) when `signal` aborts, else with an `Error` carrying `code` (exit code), `signal`, `killed`, `stdout`, `stderr` — the shape callers already read from `promisify(execFile)`.
- Produces: `packageProblem("MCP_PACKAGE_CANCELLED", 409)`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mcp-process-tree.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcessTree } from "../../server/features/mcp-packages/child-process-tree.js";

const env = { PATH: "/usr/bin:/bin" };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Waits up to two seconds: a killed child is reaped by init shortly after. */
async function gone(pid) {
  for (let i = 0; i < 100 && alive(pid); i++) await pause(20);
  return !alive(pid);
}
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "process-tree-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function pidFrom(file) {
  for (;;) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
    if (/^\d+$/.test(text)) return Number(text);
    await pause(20);
  }
}

test("a run resolves with its output like execFile", async () => {
  const result = await runProcessTree("/bin/sh", ["-c", "echo out; echo err >&2"], {
    env,
  });
  assert.deepEqual(result, { stdout: "out\n", stderr: "err\n" });
});

test("a failing run rejects with its exit code and output", async () => {
  await assert.rejects(
    runProcessTree("/bin/sh", ["-c", "echo partial; exit 3"], { env }),
    (error) => {
      assert.equal(error.code, 3);
      assert.equal(error.stdout, "partial\n");
      assert.equal(error.killed, false);
      return true;
    },
  );
});

test("an aborted run ends the whole process group and rejects as cancelled", async (t) => {
  const pidFile = path.join(scratch(t), "pid");
  const controller = new AbortController();
  const run = runProcessTree(
    "/bin/sh",
    ["-c", 'sleep 30 & echo $! > "$1"; wait', "sh", pidFile],
    { env, signal: controller.signal },
  );
  const grandchild = await pidFrom(pidFile);
  controller.abort();
  await assert.rejects(run, { code: "MCP_PACKAGE_CANCELLED" });
  assert.equal(await gone(grandchild), true);
});

test("an already aborted signal starts nothing", async (t) => {
  const marker = path.join(scratch(t), "ran");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runProcessTree("/bin/sh", ["-c", 'touch "$1"', "sh", marker], {
      env,
      signal: controller.signal,
    }),
    { code: "MCP_PACKAGE_CANCELLED" },
  );
  await pause(100);
  assert.equal(fs.existsSync(marker), false);
});

test("a timeout ends the group and rejects as killed", async (t) => {
  const pidFile = path.join(scratch(t), "pid");
  const run = runProcessTree(
    "/bin/sh",
    ["-c", 'sleep 30 & echo $! > "$1"; wait', "sh", pidFile],
    { env, timeout: 300 },
  );
  const grandchild = await pidFrom(pidFile);
  await assert.rejects(run, (error) => error.killed === true);
  assert.equal(await gone(grandchild), true);
});

test("output beyond maxBuffer stops the run", async () => {
  await assert.rejects(
    runProcessTree("/bin/sh", ["-c", "yes | head -c 100000; sleep 30"], {
      env,
      maxBuffer: 1000,
    }),
    (error) => error.killed === true,
  );
});

test("a finished run signals no process group", async (t) => {
  const kills = t.mock.method(process, "kill");
  await runProcessTree("/bin/sh", ["-c", "true"], { env });
  assert.equal(kills.mock.calls.filter((call) => call.arguments[0] < 0).length, 0);
});
```

In `tests/unit/mcp-package-errors.test.js` change the count assertion and add a message check:

```js
assert.equal(packageCodes.length, 17);
```

```js
test("a cancelled install has its own code and message", () => {
  const error = packageProblem("MCP_PACKAGE_CANCELLED", 409);
  assert.equal(error.code, "MCP_PACKAGE_CANCELLED");
  assert.equal(error.message, serverMessages.mcpPackages.cancelled);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/mcp-process-tree.test.js tests/unit/mcp-package-errors.test.js`
Expected: FAIL — `Cannot find module .../child-process-tree.js` and `Unknown package code MCP_PACKAGE_CANCELLED`.

- [ ] **Step 3: Add the code and its messages**

`server/features/mcp-packages/package-errors.js`, in `keys` after `MCP_PACKAGE_CONFIRMATION_REQUIRED`:

```js
  MCP_PACKAGE_CANCELLED: "cancelled",
```

`server/lib/i18n/de/mcp-packages.js` (append before the closing brace):

```js
  cancelled: "Die Installation wurde abgebrochen, weil der Server gelöscht wurde.",
```

`server/lib/i18n/en/mcp-packages.js`:

```js
  cancelled: "The installation was cancelled because the server was deleted.",
```

- [ ] **Step 4: Write the runner**

`server/features/mcp-packages/child-process-tree.js`:

```js
import { spawn } from "node:child_process";
import { packageProblem } from "./package-errors.js";

const cancelled = (output) =>
  Object.assign(packageProblem("MCP_PACKAGE_CANCELLED", 409), output);

/**
 * Runs `file` like a promisified execFile, but as the leader of its own process group:
 * npm and uv start scripts, builds and compilers of their own. An abort (`signal`),
 * the timeout or output beyond `maxBuffer` sends SIGTERM to the whole group, SIGKILL
 * after `graceMs` and again once the leader closed. A run that ends by itself never
 * signals the group, so a reused group id is never hit.
 */
export function runProcessTree(
  file,
  args,
  { cwd, env, timeout = 0, maxBuffer = 1024 * 1024, signal, graceMs = 5000 } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled({ stdout: "", stderr: "" }));
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return reject(Object.assign(error, { stdout: "", stderr: "" }));
    }
    let stdout = "";
    let stderr = "";
    let size = 0;
    let stopping = null;
    let timer;
    let grace;
    const killGroup = (name) => {
      try {
        process.kill(-child.pid, name);
      } catch {
        /* The group is gone already. */
      }
    };
    const stop = (reason) => {
      if (stopping) return;
      stopping = reason;
      killGroup("SIGTERM");
      grace = setTimeout(() => killGroup("SIGKILL"), graceMs);
    };
    const onAbort = () => stop("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeout > 0) timer = setTimeout(() => stop("timeout"), timeout);
    const collect = (append) => (chunk) => {
      size += chunk.length;
      if (size > maxBuffer) stop("maxBuffer");
      else append(chunk.toString());
    };
    child.stdout.on(
      "data",
      collect((text) => (stdout += text)),
    );
    child.stderr.on(
      "data",
      collect((text) => (stderr += text)),
    );
    const settle = () => {
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      settle();
      reject(Object.assign(error, { stdout, stderr }));
    });
    child.on("close", (code, killedBy) => {
      settle();
      // Stragglers of a stopped run (a build that ignores SIGTERM) go as well.
      if (stopping) killGroup("SIGKILL");
      if (stopping === "aborted") return reject(cancelled({ stdout, stderr }));
      if (code === 0 && !stopping) return resolve({ stdout, stderr });
      reject(
        Object.assign(new Error(`${file} exited with ${code ?? killedBy}`), {
          code,
          signal: killedBy,
          killed: !!stopping,
          stdout,
          stderr,
        }),
      );
    });
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/unit/mcp-process-tree.test.js tests/unit/mcp-package-errors.test.js tests/unit/server-i18n-catalogs.test.js`
Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write server/features/mcp-packages/child-process-tree.js server/features/mcp-packages/package-errors.js server/lib/i18n/de/mcp-packages.js server/lib/i18n/en/mcp-packages.js tests/unit/mcp-process-tree.test.js tests/unit/mcp-package-errors.test.js
git add server/features/mcp-packages/child-process-tree.js server/features/mcp-packages/package-errors.js server/lib/i18n/de/mcp-packages.js server/lib/i18n/en/mcp-packages.js tests/unit/mcp-process-tree.test.js tests/unit/mcp-package-errors.test.js
git commit -m "feat: run npm and uv in their own process group

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Cancel a running install when its server is deleted (owner decision 2)

**Files:**

- Create: `tests/helpers/mcp-packages-harness.js` (moved from `tests/unit/mcp-packages-service.test.js`)
- Modify: `tests/unit/mcp-packages-service.test.js` (import the harness instead of defining it)
- Modify: `server/features/mcp-packages/install-jobs.js`
- Modify: `server/features/mcp-packages/package-install-job.js`
- Modify: `server/features/mcp-packages/npm-package-install.js`, `npm-adapter.js`
- Modify: `server/features/mcp-packages/python-package-install.js`, `python-adapter.js`
- Modify: `server/features/mcp-packages/mcp-packages.js` (`cancel`)
- Modify: `server/http/routes/mcp-servers.js` (DELETE)
- Modify: `docs/mcp.md` (delete during an install)
- Test: `tests/unit/mcp-install-jobs.test.js`, `tests/unit/mcp-package-cancel.test.js`, `tests/integration/mcp-packages-cancel.test.js`, `tests/integration/mcp-packages-routes.test.js`

**Interfaces:**

- Consumes: `runProcessTree` (Task 1), `MCP_PACKAGE_CANCELLED`.
- Produces: `PackageJobs#cancel(serverId) → Promise<boolean>`; work callback `(log, note, signal)`; job state `cancelled` with code `MCP_PACKAGE_CANCELLED`.
- Produces: `activate(service, serverId, fields, command, leading, { signal } = {})` — later tasks call it with this signature.
- Produces: `harness(t, options)` in `tests/helpers/mcp-packages-harness.js` with options `{ toolchainDir, failSwitch, afterCommit, beforeSwitch, ciOutput, onCi, adapters }` and exports `harness`, `source`, `attach`, `deferred`, `installEntries`, `integrity`.
- Produces: `McpPackages#cancel(id) → Promise<boolean>`.

- [ ] **Step 1: Move the unit harness into a helper**

Create `tests/helpers/mcp-packages-harness.js` with the body of `harness`, `registryUrl`, `integrity`, `lockOf`, `packument`, `source`, `attach`, `deferred` and `installEntries` cut from `tests/unit/mcp-packages-service.test.js` lines 14–111, exported, with these changes:

```js
// A valid SRI shape (sha512 is 64 bytes: 86 base64 characters plus "==").
export const integrity = `sha512-${"A".repeat(86)}==`;
```

and the harness signature and its two hooks:

```js
export function harness(
  t,
  { toolchainDir, failSwitch = false, afterCommit, beforeSwitch, ciOutput, onCi, adapters } = {},
) {
```

```js
const changes = {
  update: async (id, patch) => {
    await beforeSwitch?.(id, patch);
    switches.push({ patch, record: records.get(id) });
    if (failSwitch) throw Object.assign(Error("conflict"), { status: 500 });
    rows.set(id, { ...rows.get(id), ...patch, revision: rows.get(id).revision + 1 });
    await afterCommit?.();
  },
};
```

```js
const execute = async (_node, args, options) => {
  const { cwd } = options;
  npmCalls.push(args[1]);
  if (args.includes("--package-lock-only"))
    fs.writeFileSync(path.join(cwd, "package-lock.json"), lockOf());
  if (args[1] === "ci") {
    await onCi?.(options);
    const dir = path.join(cwd, "node_modules", "x");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", version: "1.0.0" }),
    );
    fs.writeFileSync(path.join(dir, "index.js"), "");
    return { stdout: ciOutput?.(cwd) ?? "", stderr: "" };
  }
  return { stdout: "", stderr: "" };
};
```

(The installed `package.json` gains `name: "x"` now so Task 8's name check needs no fixture change.) The harness returns `{ dataDir, service, records, rows, switches, npmCalls }` as before. In `tests/unit/mcp-packages-service.test.js` replace the removed block with:

```js
import {
  attach,
  deferred,
  harness,
  installEntries,
  integrity,
  source,
} from "../helpers/mcp-packages-harness.js";
```

and replace the literal `"sha512-top"` in `heldAdapter` with `integrity`.

Run: `node --test tests/unit/mcp-packages-service.test.js`
Expected: PASS (pure move).

- [ ] **Step 2: Write the failing tests**

Append to `tests/unit/mcp-install-jobs.test.js`:

```js
test("cancel aborts the job's signal and settles it as cancelled", async () => {
  const jobs = new PackageJobs();
  let seen;
  jobs.run("s1", { kind: "install", installId: "i1" }, (_log, _note, signal) => {
    seen = signal;
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(Error("aborted"))),
    );
  });
  await tick();
  assert.equal(seen.aborted, false);
  assert.equal(await jobs.cancel("s1"), true);
  assert.equal(seen.aborted, true);
  assert.equal(jobs.get("s1").state, "cancelled");
  assert.equal(jobs.get("s1").code, "MCP_PACKAGE_CANCELLED");
  assert.equal(jobs.runningInstallIds().size, 0);
  assert.equal(await jobs.cancel("s1"), false);
  assert.equal(await jobs.cancel("unknown"), false);
});
```

`tests/unit/mcp-package-cancel.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  attach,
  deferred,
  harness,
  installEntries,
} from "../helpers/mcp-packages-harness.js";

test("npm ci gets the job's signal; a cancel during it removes the stage", async (t) => {
  const reached = deferred();
  const signals = [];
  const { dataDir, service, records } = harness(t, {
    onCi: async ({ signal }) => {
      signals.push(signal);
      reached.resolve();
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      throw Object.assign(Error("The operation was aborted"), { name: "AbortError" });
    },
  });
  await attach(service);
  await reached.promise;
  assert.ok(signals[0] instanceof AbortSignal);
  records.remove("s1");
  assert.equal(await service.cancel("s1"), true);
  assert.equal(service.jobs.get("s1").state, "cancelled");
  await service.prune();
  assert.deepEqual(installEntries(dataDir), []);
});

test("a cancel during the command switch restores no record", async (t) => {
  const reached = deferred();
  const held = deferred();
  const { service, records } = harness(t, {
    beforeSwitch: async () => {
      reached.resolve();
      await held.promise;
      throw Object.assign(Error("gone"), { status: 404 });
    },
  });
  await attach(service);
  await reached.promise;
  records.remove("s1");
  const cancelled = service.cancel("s1");
  held.resolve();
  assert.equal(await cancelled, true);
  assert.equal(records.get("s1"), null);
});
```

`tests/integration/mcp-packages-cancel.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  createPackaged,
  installsOf,
  packageService,
} from "../helpers/mcp-packages-service.js";

test("deleting a server during its install stops npm and leaves no stage", async (t) => {
  const s = await packageService(t);
  const held = s.hold();
  const { server } = await createPackaged(s);
  await held.reached;
  await s.changes.remove(server.id);
  const cancelled = s.packages.cancel(server.id);
  held.release();
  assert.equal(await cancelled, true);
  const job = s.packages.jobs.get(server.id);
  assert.equal(job.state, "cancelled");
  assert.equal(job.code, "MCP_PACKAGE_CANCELLED");
  await s.packages.prune();
  assert.deepEqual(installsOf(s.dataDir), []);
  assert.equal(s.servers.packages.get(server.id), null);
});
```

Append to `tests/integration/mcp-packages-routes.test.js`:

```js
test("deleting a server cancels its running install before pruning", async (t) => {
  const calls = [];
  const { request } = await app(t, {
    mcpPackages: {
      cancel: (id) => {
        calls.push(["cancel", id]);
        return Promise.resolve(true);
      },
      prune: () => calls.push(["prune"]),
    },
  });
  const response = await request("DELETE", "/api/mcp-servers/s1");
  assert.equal(response.status, 204);
  assert.deepEqual(calls, [["cancel", "s1"], ["prune"]]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/unit/mcp-install-jobs.test.js tests/unit/mcp-package-cancel.test.js tests/integration/mcp-packages-cancel.test.js tests/integration/mcp-packages-routes.test.js`
Expected: FAIL — `jobs.cancel is not a function`, `service.cancel is not a function`, route calls `[["prune"]]`.

- [ ] **Step 4: Jobs carry an AbortController**

In `server/features/mcp-packages/install-jobs.js`, replace `run` and add `cancel`:

```js
  run(serverId, { kind, installId = null }, work) {
    if (this.jobs.get(serverId)?.state === "running")
      throw packageProblem("MCP_PACKAGE_BUSY", 409);
    const controller = new AbortController();
    const job = {
      kind,
      installId,
      toolchainDir: null,
      state: "running",
      code: null,
      log: "",
      controller,
    };
    this.jobs.set(serverId, job);
    const log = (text) => {
      job.log = redact(`${job.log}${text}\n`).slice(-tailLimit);
    };
    const note = ({ toolchainDir } = {}) => {
      if (typeof toolchainDir === "string") job.toolchainDir = toolchainDir;
    };
    const promise = Promise.resolve()
      .then(() => work(log, note, controller.signal))
      .then(
        () => {
          job.state = "done";
        },
        (error) => {
          // A cancel wins over whatever the aborted npm or uv reported.
          const aborted = controller.signal.aborted;
          job.state = aborted ? "cancelled" : "failed";
          job.code = aborted
            ? "MCP_PACKAGE_CANCELLED"
            : packageCode(error, "MCP_PACKAGE_INSTALL_FAILED");
        },
      )
      .finally(() => {
        try {
          this.settled(serverId);
        } catch {
          /* Pruning runs again after the next job and at start. */
        }
        this.running.delete(promise);
      });
    job.promise = promise;
    this.running.add(promise);
    return this.get(serverId);
  }
  /** Aborts the running job of `serverId`; true once it settled, false when none ran. */
  cancel(serverId) {
    const job = this.jobs.get(serverId);
    if (job?.state !== "running") return Promise.resolve(false);
    job.controller.abort();
    return job.promise.then(() => true);
  }
```

- [ ] **Step 5: Thread the signal through the install**

In `server/features/mcp-packages/package-install-job.js`:

Add after `logFailure`:

```js
/** Stops a cancelled job between its steps; npm and uv stop through the signal. */
export function stopIfCancelled(signal) {
  if (signal?.aborted) throw packageProblem("MCP_PACKAGE_CANCELLED", 409);
}
```

Change the job body in `runInstall` to take the signal and check it between steps:

```js
  return service.jobs.run(serverId, { kind, installId }, async (jobLog, note, signal) => {
```

- before `const toolchain = await service.toolchain(...)`: nothing; right after it: `stopIfCancelled(signal);`
- `adapter.install({ ..., log, signal })`
- before `commitInstall(...)`: `stopIfCancelled(signal);`
- before `await activate(`: `stopIfCancelled(signal);` and pass `{ signal }` as the sixth argument.

Replace `activate`:

```js
export async function activate(
  service,
  serverId,
  fields,
  command,
  leading,
  { signal } = {},
) {
  const previous = service.records.get(serverId);
  // Before the first install the stored args are the owner's only.
  const before = previous?.installId ? previous.leadingArgs : 0;
  const { revision } = service.servers.get(serverId);
  service.switching.set(serverId, { before, revision });
  service.records.put(serverId, fields);
  try {
    await switchCommand(service, serverId, command, leading, before);
  } catch (error) {
    // A deleted server keeps no record: its row went with it.
    if (previous && !signal?.aborted) service.records.put(serverId, previous);
    throw error;
  } finally {
    service.switching.delete(serverId);
  }
}
```

In `failed()`, nothing changes (a deleted server has no record; the stage goes).

In `server/features/mcp-packages/npm-package-install.js`:

```js
import { runProcessTree } from "./child-process-tree.js";
```

Remove `execFile`/`promisify`/`executeFile`; default `execute = runProcessTree` in `resolveNpm` and `installNpm`. Give `npm()` a signal and keep a cancel:

```js
async function npm(args, { cwd, node, env, execute, log, signal }) {
  try {
    const { stdout, stderr } = await execute(
      node.nodePath,
      [node.npmCliPath, ...args, "--no-audit", "--no-fund"],
      { cwd, env, timeout: 600000, maxBuffer: 4 * 1024 * 1024, signal },
    );
    log?.(`${stdout}\n${stderr}`);
  } catch (error) {
    log?.(`${error.stdout || ""}\n${error.stderr || ""}`);
    if (signal?.aborted) throw packageProblem("MCP_PACKAGE_CANCELLED", 409);
    throw failed();
  }
}
```

`installNpm` takes `signal` and passes it into its `npm([...], { cwd: directory, node, env, execute, log, signal })` call. `npmAdapter.install` destructures `signal` and passes it to `installNpm`.

In `server/features/mcp-packages/python-package-install.js`: same import and default (`execute = runProcessTree` in `resolvePython` and `installPython`); `uv()` gets the signal:

```js
async function uv(python, args, { cwd, env, execute, log, signal }) {
  try {
    const { stdout, stderr } = await execute(python.uvPath, args, {
      cwd,
      env,
      timeout: 600000,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    });
    log?.(`${stdout}\n${stderr}`);
    return { ok: true, output: "" };
  } catch (error) {
    const output = `${error.stdout || ""}\n${error.stderr || ""}`;
    log?.(output);
    if (signal?.aborted) throw packageProblem("MCP_PACKAGE_CANCELLED", 409);
    return { ok: false, output };
  }
}
```

`installPython` takes `signal` and builds `const options = { cwd: work, env, execute, log, signal };`. `pythonAdapter.install` destructures `signal` and passes it.

- [ ] **Step 6: Service and route**

`server/features/mcp-packages/mcp-packages.js`, after `install()`:

```js
  /** Stops the running install of `id` (its server was deleted); see PackageJobs#cancel. */
  cancel(id) {
    return this.jobs.cancel(id);
  }
```

`server/http/routes/mcp-servers.js`, DELETE handler:

```js
const { pending, logoutDeferred, transport } = await changes().remove(req.params.id);
// A running install of the deleted server stops now: npm or uv end with their
// whole process tree and the stage goes. Its package record went with the server;
// installs and toolchains follow in the background (neither call rejects).
services.mcpPackages?.cancel(req.params.id);
services.mcpPackages?.prune();
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/unit/mcp-install-jobs.test.js tests/unit/mcp-package-cancel.test.js tests/unit/mcp-packages-service.test.js tests/unit/mcp-python-install.test.js tests/integration/mcp-packages-cancel.test.js tests/integration/mcp-packages-routes.test.js tests/integration/mcp-npm-install.test.js tests/integration/mcp-packages-service.test.js`
Expected: PASS.

- [ ] **Step 8: Document it**

`docs/mcp.md`, the **Use own command** bullet: replace "Deleting the server is allowed during a running install: the job then fails and its files are cleaned up." with:

```markdown
Deleting the server is allowed during a running install: AgentPier stops the
running npm or uv process (with the scripts and builds it started) at once and
removes the unfinished install.
```

- [ ] **Step 9: Format and commit**

```bash
npx prettier --write server/features/mcp-packages server/http/routes/mcp-servers.js tests/helpers/mcp-packages-harness.js tests/unit/mcp-packages-service.test.js tests/unit/mcp-install-jobs.test.js tests/unit/mcp-package-cancel.test.js tests/integration/mcp-packages-cancel.test.js tests/integration/mcp-packages-routes.test.js docs/mcp.md
git add -A server/features/mcp-packages server/http/routes/mcp-servers.js tests docs/mcp.md
git commit -m "feat: cancel a running MCP package install when its server is deleted

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Preview lifecycle and attach/detach errors

**Files:**

- Modify: `server/features/mcp-packages/mcp-packages.js`
- Test: `tests/unit/mcp-package-previews.test.js`, `tests/unit/mcp-packages-service.test.js` (concurrent-attach test), `tests/integration/mcp-packages-service.test.js` (rename `takePreview` uses if any)

**Interfaces:**

- Produces: `peekPreview(previewId, source) → preview` (validates, leaves it in place; drops an expired one), `consumePreview(previewId)` (deletes; throws `MCP_PACKAGE_PREVIEW_EXPIRED` 409 when already gone), `confirmedPreview(previewId, source, wanted)` no longer consumes.
- `takePreview` is removed; `grep -rn takePreview server tests web` must be empty afterwards.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mcp-package-previews.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpPackages } from "../../server/features/mcp-packages/mcp-packages.js";
import { deferred, harness, source } from "../helpers/mcp-packages-harness.js";

const twoPrograms = {
  toolchainKind: "node",
  preview: async () => ({
    integrity: "sha256:a",
    programs: [
      { name: "a-server", path: "a.js" },
      { name: "b-server", path: "b.js" },
    ],
    needsScripts: false,
    manifestText: "{}",
    lockText: "x",
    digest: "d",
    dependencies: [],
  }),
};

test("a refused program keeps the preview for a retry", async (t) => {
  const { service } = harness(t, { adapters: { npm: twoPrograms } });
  const { previewId } = await service.preview(source);
  assert.throws(() => service.confirmedPreview(previewId, source, "nope"), {
    code: "MCP_PACKAGE_PROGRAM_REQUIRED",
  });
  assert.ok(service.previews.has(previewId));
  const { program } = service.confirmedPreview(previewId, source, "b-server");
  assert.equal(program.name, "b-server");
});

test("a refused scripts check keeps the preview", async (t) => {
  const { service } = harness(t, {
    adapters: {
      npm: {
        ...twoPrograms,
        preview: async () => ({ ...(await twoPrograms.preview()), needsScripts: true }),
      },
    },
  });
  const { previewId } = await service.preview(source);
  assert.throws(() => service.confirmedPreview(previewId, source, "a-server"), {
    code: "MCP_PACKAGE_NEEDS_SCRIPTS",
  });
  assert.ok(service.previews.has(previewId));
});

test("a preview is consumed once", async (t) => {
  const { service } = harness(t);
  const { previewId } = await service.preview(source);
  service.consumePreview(previewId);
  assert.throws(() => service.consumePreview(previewId), {
    code: "MCP_PACKAGE_PREVIEW_EXPIRED",
  });
});

test("a rejected preview frees its resolve slot", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-preview-slot-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let calls = 0;
  const service = new McpPackages({
    dataDir,
    servers: { packages: { get: () => null } },
    changes: {},
    toolchain: async () => ({}),
    previewConcurrency: 1,
    adapters: {
      npm: {
        ...twoPrograms,
        preview: async () => {
          calls += 1;
          if (calls === 1) throw Error("uv exploded at /private/path");
          return twoPrograms.preview();
        },
      },
    },
  });
  await assert.rejects(service.preview(source), { code: "MCP_PACKAGE_INSTALL_FAILED" });
  assert.equal(service.resolving, 0);
  assert.equal((await service.preview(source)).programs.length, 2);
});

test("a detach whose record cannot be removed answers with a package code", async (t) => {
  const { service, records } = harness(t);
  records.put("s1", { status: "ready", installId: null });
  records.remove = () => {
    throw Error("SQLITE_BUSY: database is locked at /private/data/mcp.db");
  };
  await assert.rejects(
    service.detach("s1", async () => {}),
    (error) => {
      assert.equal(error.code, "MCP_PACKAGE_INSTALL_FAILED");
      assert.doesNotMatch(error.message, /private|SQLITE/);
      return true;
    },
  );
});

test("an attach whose record cannot be written keeps its preview", async (t) => {
  const { service, records } = harness(t);
  const { previewId } = await service.preview(source);
  records.put = () => {
    throw Error("SQLITE_FULL at /private/data/mcp.db");
  };
  await assert.rejects(service.attach("s1", { source, previewId }), {
    code: "MCP_PACKAGE_INSTALL_FAILED",
  });
  assert.ok(service.previews.has(previewId));
});

test("a losing concurrent attach keeps its preview", async (t) => {
  const { service } = harness(t);
  const first = await service.preview(source);
  const second = await service.preview(source);
  const gate = deferred();
  const one = service.attach(
    "s1",
    { source, previewId: first.previewId },
    () => gate.promise,
  );
  const two = service.attach(
    "s1",
    { source, previewId: second.previewId },
    () => gate.promise,
  );
  gate.resolve();
  await one;
  await assert.rejects(two, { code: "MCP_PACKAGE_BUSY" });
  assert.equal(service.previews.has(first.previewId), false);
  assert.equal(service.previews.has(second.previewId), true);
  await service.jobs.idle();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/mcp-package-previews.test.js`
Expected: FAIL — previews deleted by `confirmedPreview`, `consumePreview is not a function`, raw SQLite error in detach/attach.

- [ ] **Step 3: Implement peek/consume and wrap the store writes**

In `server/features/mcp-packages/mcp-packages.js` import `installError` from `./package-install-job.js` and replace `takePreview`/`confirmedPreview`:

```js
  /** The confirmed preview for `source`, left in place; expired, unknown or different → refused. */
  peekPreview(previewId, source) {
    const preview = this.previews.get(previewId);
    const ref = packageRef(source);
    const expired = preview && preview.expires < this.now();
    if (expired) this.previews.delete(previewId);
    if (
      !preview ||
      expired ||
      preview.ref.registry !== ref.registry ||
      preview.ref.name !== ref.name ||
      preview.ref.version !== ref.version ||
      preview.allowScripts !== (source.allowScripts === true) ||
      // The lock was resolved under exactly these constraints (canonical form).
      JSON.stringify(preview.constraints) !==
        JSON.stringify(packageConstraints(source, ref))
    )
      throw packageProblem("MCP_PACKAGE_PREVIEW_EXPIRED", 409);
    return preview;
  }
  /** Takes a checked preview once; a second use of the same id is refused. */
  consumePreview(previewId) {
    if (!this.previews.delete(previewId))
      throw packageProblem("MCP_PACKAGE_PREVIEW_EXPIRED", 409);
  }
  /**
   * The preview with the scripts rule checked and its program chosen; it stays until
   * the caller consumes it, so a refused choice can be retried. Without programs at
   * preview time the install names them (adapter.programsAfterInstall).
   */
  confirmedPreview(previewId, source, wanted) {
    const preview = this.peekPreview(previewId, source);
    // Before the program: a package that must be built names its programs only then.
    if (preview.needsScripts === true && !preview.allowScripts)
      throw packageProblem("MCP_PACKAGE_NEEDS_SCRIPTS", 400);
    const program = preview.programs.length
      ? chooseProgram(preview.programs, wanted)
      : laterProgram(wanted);
    return { preview, program };
  }
```

`createServer` consumes before the create and restores on a failed create:

```js
const confirmed = this.confirmedPreview(previewId, source, program ?? source.program);
this.consumePreview(previewId);
let server;
try {
  // Written in the server's own transaction: the first reconciliation already sees
  // a package that is installing, not a stdio server without a command.
  server = await this.changes.create(definition, {
    confirmStdio: true,
    pendingCommand: true,
    packageRecord: this.pendingRecord(confirmed),
    ...(clis === undefined ? {} : { clis }),
  });
} catch (error) {
  // Nothing was stored (a taken name, a refused CLI): the owner may save again.
  this.previews.set(previewId, confirmed.preview);
  throw error;
}
this.install(server.id, { ...confirmed, kind: "install" });
return this.servers.get(server.id);
```

`attach` consumes only after it won:

```js
this.requireIdle(id);
if (this.isPackaged(id)) throw packageProblem("MCP_PACKAGE_BUSY", 409);
// Taken only now: an attach that lost to a concurrent one keeps its preview.
this.consumePreview(previewId);
try {
  this.records.put(id, this.pendingRecord(confirmed));
} catch (error) {
  this.previews.set(previewId, confirmed.preview);
  throw installError(error);
}
this.install(id, { ...confirmed, kind: "install" });
return this.servers.get(id);
```

`detach` wraps the removal:

```js
await update?.();
try {
  if (this.isPackaged(id)) this.records.remove(id);
} catch (error) {
  throw installError(error);
}
```

`updatePackage` consumes right after `confirmedPreview(...)`:

```js
this.consumePreview(previewId);
return { job: this.install(id, { ...confirmed, kind: "update" }) };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `grep -rn takePreview server tests web; node --test tests/unit/mcp-package-previews.test.js tests/unit/mcp-packages-service.test.js tests/integration/mcp-packages-service.test.js tests/integration/mcp-packages-routes.test.js`
Expected: no grep output; PASS. (If an existing test asserted that a refused confirmation deleted the preview, change it to assert the preview stays — that is the fixed behaviour.)

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write server/features/mcp-packages/mcp-packages.js tests/unit/mcp-package-previews.test.js
git add server/features/mcp-packages/mcp-packages.js tests/unit/mcp-package-previews.test.js tests/unit/mcp-packages-service.test.js tests/integration/mcp-packages-service.test.js
git commit -m "fix: keep MCP package previews until an install really takes them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Service state — orphaned installs, the switch race and start()

**Files:**

- Modify: `server/features/mcp-packages/package-records.js` (orphan hook)
- Modify: `server/features/mcp-packages/mcp-packages.js` (`claiming`, `storedLeading`, `start`)
- Modify: `server/features/mcp-packages/package-install-job.js` (`switching` entries, `switchedTo`)
- Test: `tests/unit/mcp-package-state.test.js`, `tests/integration/mcp-packages-service-recovery.test.js`

**Interfaces:**

- Consumes: `activate(..., { signal })` from Task 2.
- Produces: `PackageRecords#orphaned` (assignable function, default `() => false`); `service.switching.get(id) → { before, after, command, leading }`; `switchedTo(server, switching)` exported from `package-install-job.js`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mcp-package-state.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpPackages } from "../../server/features/mcp-packages/mcp-packages.js";
import { attach, harness } from "../helpers/mcp-packages-harness.js";

test("an owner edit racing the switch keeps the old leading args until it commits", async (t) => {
  let raced = false;
  let racedArgs;
  const { service, rows } = harness(t, {
    beforeSwitch: () => {
      if (raced) return;
      raced = true;
      // The owner saved first: the revision moved on, the old command is still stored.
      rows.set("s1", { ...rows.get("s1"), revision: rows.get("s1").revision + 1 });
      racedArgs = service.prepareUpdate("s1", {
        revision: rows.get("s1").revision,
        args: ["--new"],
      }).args;
    },
  });
  await attach(service);
  await service.jobs.idle();
  assert.equal(raced, true);
  // Before the first install there are no generated args to keep.
  assert.deepEqual(racedArgs, ["--new"]);
});

test("a restart leaves rows alone while agents are in maintenance", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-start-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let reconciled = 0;
  const row = { serverId: "s1", status: "ready", installId: "x", lockDigest: "d" };
  const records = {
    all: () => [row],
    get: () => row,
    update: () => {},
    installIds: () => new Set(),
    computedStatus: () => "missing",
  };
  const service = new McpPackages({
    dataDir,
    servers: { packages: records },
    changes: { maintenance: () => true, onSaved: async () => (reconciled += 1) },
  });
  await service.start();
  assert.equal(reconciled, 0);
});

test("a start that cannot write a record logs a code, never the error text", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-start-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const errors = t.mock.method(console, "error", () => {});
  const row = { serverId: "s1", status: "installing", installId: null };
  const records = {
    all: () => [row],
    get: () => row,
    update: () => {
      throw Error("SQLITE_BUSY at /private/data/mcp.db");
    },
    installIds: () => new Set(),
    computedStatus: () => "failed",
  };
  const service = new McpPackages({
    dataDir,
    servers: { packages: records },
    changes: { onSaved: async () => {} },
  });
  await service.start();
  const logged = errors.mock.calls.map((call) => String(call.arguments[0])).join("\n");
  assert.match(logged, /MCP_PACKAGE_INSTALL_FAILED/);
  assert.doesNotMatch(logged, /private|SQLITE/);
});
```

Append to `tests/integration/mcp-packages-service-recovery.test.js`:

```js
test("an installing record without a job reads as failed until a reinstall", async (t) => {
  const s = await packageService(t);
  // As after a backup restore: the record says installing, no job runs.
  const orphan = s.servers.create(
    { name: "restored", transport: "stdio" },
    { pendingCommand: true, packageRecord: stored() },
  );
  const source = s.servers.get(orphan.id).source;
  assert.equal(source.status, "failed");
  assert.equal(source.errorCode, "MCP_PACKAGE_INSTALL_FAILED");
  assert.equal(s.packages.status(orphan.id).error.code, "MCP_PACKAGE_INSTALL_FAILED");
  // The stored row is unchanged; start() persists the verdict.
  assert.equal(s.servers.packages.get(orphan.id).status, "installing");
});

test("a server being created reads as installing to its own first reconciliation", async (t) => {
  const s = await packageService(t);
  await createPackaged(s);
  const first = s.saved[0].definitions.find((d) => d.name === "pkg");
  assert.equal(first.packageStatus, "installing");
  await s.packages.jobs.idle();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/mcp-package-state.test.js tests/integration/mcp-packages-service-recovery.test.js`
Expected: FAIL — `racedArgs` is `["--flag", "--new"]` (the race), `reconciled` is 1, raw SQLite error escapes `start()`, orphan reads `installing`.

- [ ] **Step 3: Orphan hook in the records**

`server/features/mcp-packages/package-records.js`, in the constructor after the migration code:

```js
// McpPackages answers this: an `installing` row no job owns (a restore, a crash
// before start()) reads as failed instead of installing forever.
this.orphaned = () => false;
```

and `computedStatus` / `publicFields`:

```js
  computedStatus(row) {
    if (row.status === "installing" && this.orphaned(row.serverId)) return "failed";
    if (row.status !== "ready") return row.status;
    return row.installId && readInstall(this.dataDir, row.installId, row.lockDigest)
      ? "ready"
      : "missing";
  }
```

In `publicFields`, compute the status once and fill the code for an orphan:

```js
const status = this.computedStatus(row);
return {
  source: {
    registry: row.registry,
    name: row.name,
    version: row.version,
    program: row.program,
    allowScripts: row.allowScripts,
    status,
    errorCode:
      row.errorCode ?? (status === "failed" ? "MCP_PACKAGE_INSTALL_FAILED" : null),
    // No generated argument is stored before the first install.
    leadingArgs: row.installId ? row.leadingArgs : 0,
    constraints: row.constraints,
  },
};
```

- [ ] **Step 4: The service answers the hook, guards the switch and start()**

`server/features/mcp-packages/mcp-packages.js` constructor, after `this.detaching = new Set();`:

```js
// createServer() calls between storing the installing record and starting its job.
this.claiming = 0;
this.records.orphaned = (id) =>
  this.claiming === 0 && this.jobs.get(id)?.state !== "running";
```

`createServer`: wrap from `this.consumePreview(previewId)` to `this.install(...)` in

```js
this.claiming += 1;
try {
  // ...consume, create (with its catch), install as in Task 3...
} finally {
  this.claiming -= 1;
}
```

Replace `storedLeading`:

```js
  /**
   * Generated args stored in front of the owner's; 0 before the first install. While
   * a switch runs, its old count holds until the stored command is the switch's own
   * (an owner edit racing it keeps the old command and the old count).
   */
  storedLeading(id, row) {
    const switching = this.switching.get(id);
    if (switching)
      return switchedTo(this.servers.get(id), switching) ? switching.after : switching.before;
    return row?.installId ? row.leadingArgs : 0;
  }
```

(import `switchedTo` from `./package-install-job.js`).

`start()`: wrap the per-row update and respect maintenance:

```js
for (const row of this.records.all())
  if (row.status === "installing" && !this.jobs.get(row.serverId))
    try {
      this.records.update(row.serverId, {
        status: "failed",
        errorCode: "MCP_PACKAGE_INSTALL_FAILED",
      });
    } catch (error) {
      logFailure("record an interrupted MCP package install", error);
    }
// An install deleted while AgentPier was stopped (or a restore) is missing: the CLIs
// drop its entry now instead of starting a deleted program until a reinstall. Agents
// in maintenance refuse changes; the next change or CLI session reconciles then.
const missing =
  !this.changes.maintenance?.() &&
  this.records.all().some((row) => this.records.computedStatus(row) === "missing");
```

(`CentralMcpChanges` already exposes `maintenance` as a constructor-assigned function.)

`server/features/mcp-packages/package-install-job.js`:

```js
/** Whether the stored server already runs the switch's command and generated args. */
export const switchedTo = (server, { command, leading }) =>
  server?.command === command &&
  leading.every((arg, index) => server.args?.[index] === arg);
```

In `activate` replace `const { revision } = service.servers.get(serverId); service.switching.set(serverId, { before, revision });` with

```js
// The new install's id is in the command (PyPI) or its first arg (npm), so the
// stored definition says unambiguously whether the switch has committed.
service.switching.set(serverId, { before, after: leading.length, command, leading });
```

and in `switchCommand` delete the line `service.switching.set(serverId, { before, revision: server.revision });`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/unit/mcp-package-state.test.js tests/unit/mcp-packages-service.test.js tests/integration/mcp-packages-service-recovery.test.js tests/integration/mcp-packages-service.test.js tests/unit/mcp-package-records.test.js`
Expected: PASS (including the existing "an owner edit with the switched revision keeps the generated args" and "an owner edit during the switch is kept and retried once").

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write server/features/mcp-packages tests/unit/mcp-package-state.test.js tests/integration/mcp-packages-service-recovery.test.js
git add server/features/mcp-packages tests/unit/mcp-package-state.test.js tests/integration/mcp-packages-service-recovery.test.js
git commit -m "fix: report orphaned MCP package installs and close the switch race

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Package records — migration, `choosing` status, one query per list

**Files:**

- Modify: `server/features/mcp-packages/package-records.js`
- Modify: `server/features/mcp-servers/mcp-server-store.js` (`list`, `definitions`, `publicServer`, `create`)
- Test: `tests/unit/mcp-package-records-migration.test.js`, `tests/unit/mcp-package-records.test.js`

**Interfaces:**

- Produces: status `choosing` accepted by the table; `byServer() → Map`; `publicFields(serverId, rows?)`, `definitionFields(serverId, rows?)`; `computedStatus` maps `choosing` without its install to `missing`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mcp-package-records-migration.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PackageRecords } from "../../server/features/mcp-packages/package-records.js";

// The table as PR 2 created it: no constraints, no needs_scripts, three statuses.
const oldSchema = `
CREATE TABLE servers(id TEXT PRIMARY KEY);
CREATE TABLE server_packages(
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  registry TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL,
  program TEXT NOT NULL, program_path TEXT NOT NULL, allow_scripts INTEGER NOT NULL DEFAULT 0,
  lock TEXT NOT NULL, lock_digest TEXT NOT NULL, integrity TEXT NOT NULL,
  install_id TEXT, leading_args INTEGER NOT NULL DEFAULT 0, toolchain_dir TEXT,
  status TEXT NOT NULL CHECK(status IN ('installing','ready','failed')),
  error_code TEXT, updated_at INTEGER NOT NULL);
INSERT INTO servers VALUES ('s1');
INSERT INTO server_packages VALUES ('s1','pypi','x','1.0','x','x',1,'l','d','i',NULL,0,NULL,'failed',NULL,1);`;

function oldDatabase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-records-migration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, "mcp.db"));
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(oldSchema);
  return { db, dir };
}

test("an old table gains the new columns, keeps its rows and accepts choosing", (t) => {
  const { db, dir } = oldDatabase(t);
  const records = new PackageRecords(db, dir);
  const row = records.get("s1");
  assert.equal(row.status, "failed");
  assert.equal(row.needsScripts, true, "backfilled from allow_scripts");
  assert.deepEqual(row.constraints, []);
  records.update("s1", { status: "choosing" });
  assert.equal(records.get("s1").status, "choosing");
  // Opening again changes nothing.
  new PackageRecords(db, dir);
  assert.equal(records.get("s1").status, "choosing");
});

test("a failing migration rolls back to the old table", (t) => {
  const { db, dir } = oldDatabase(t);
  const failing = {
    exec: (sql) => {
      if (/^UPDATE server_packages SET needs_scripts/.test(sql)) throw Error("disk I/O");
      return db.exec(sql);
    },
    prepare: (sql) => db.prepare(sql),
  };
  assert.throws(() => new PackageRecords(failing, dir), /disk I\/O/);
  const columns = db
    .prepare("PRAGMA table_info(server_packages)")
    .all()
    .map((c) => c.name);
  assert.equal(columns.includes("needs_scripts"), false);
  assert.equal(columns.includes("constraints"), false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM server_packages").get().n, 1);
});
```

In `tests/unit/mcp-package-records.test.js` add the matchers and new cases:

```js
test("pendingCommand never stores an owner command; a record needs pendingCommand", (t) => {
  const { servers } = store(t);
  assert.throws(
    () =>
      servers.create(
        { name: "pkg", transport: "stdio", command: "/bin/sh" },
        { pendingCommand: true },
      ),
    { status: 400 },
  );
  assert.throws(
    () =>
      servers.create(
        { name: "pkg", transport: "stdio", command: "/bin/sh" },
        { packageRecord: record() },
      ),
    { status: 400 },
  );
  assert.deepEqual(servers.list(), []);
});

test("only a literal true pendingCommand stores a server without a command", (t) => {
  const { servers } = store(t);
  assert.throws(
    () => servers.create({ name: "pkg", transport: "stdio" }, { pendingCommand: "yes" }),
    { status: 400 },
  );
  assert.deepEqual(servers.list(), []);
});

test("listing servers reads all package records in one query", (t) => {
  const { servers } = store(t);
  pending(servers, {}, {});
  servers.create(
    { name: "pkg2", transport: "stdio" },
    { pendingCommand: true, packageRecord: record() },
  );
  const get = t.mock.method(servers.packages, "get");
  assert.equal(servers.list().length, 2);
  assert.equal(servers.definitions().length, 2);
  assert.equal(get.mock.callCount(), 0);
});

test("a choosing record whose install is gone is missing", (t) => {
  const { servers, dataDir } = store(t);
  const { installId, stage } = stageInstall(dataDir);
  commitInstall(dataDir, { installId, stage, receipt: { lockDigest: "d".repeat(64) } });
  const server = pending(servers, {}, { status: "choosing", installId });
  assert.equal(servers.get(server.id).source.status, "choosing");
  fs.rmSync(path.join(dataDir, "mcp-packages", "installs", installId), {
    recursive: true,
  });
  assert.equal(servers.get(server.id).source.status, "missing");
});
```

(If the existing `invalid()` of the store answers another status than 400, use that status in the matchers; check `server/features/mcp-servers/mcp-server-store.js` `invalid`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/mcp-package-records-migration.test.js tests/unit/mcp-package-records.test.js`
Expected: FAIL — CHECK constraint failed for `choosing`; `pendingCommand: "yes"` accepted; `get` called per row; rollback leaves new columns.

- [ ] **Step 3: Migrate in one transaction, rebuild the CHECK when needed**

`server/features/mcp-packages/package-records.js`: change the schema's status line to

```js
  status TEXT NOT NULL CHECK(status IN ('installing','ready','failed','choosing')),
```

make the schema a function of the table name and replace the constructor's migration:

```js
const schema = (table) => `
CREATE TABLE IF NOT EXISTS ${table}(
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  ...unchanged columns...
  status TEXT NOT NULL CHECK(status IN ('installing','ready','failed','choosing')),
  error_code TEXT, updated_at INTEGER NOT NULL,
  constraints TEXT NOT NULL DEFAULT '[]', needs_scripts INTEGER NOT NULL DEFAULT 0);`;
```

```js
  constructor(db, dataDir) {
    Object.assign(this, { db, dataDir });
    // One transaction: added columns, their backfill and a rebuilt status check land
    // together or not at all (SQLite DDL is transactional).
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(schema("server_packages"));
      const known = new Set(
        db
          .prepare("PRAGMA table_info(server_packages)")
          .all()
          .map((column) => column.name),
      );
      for (const [name, type, from] of addedColumns)
        if (!known.has(name)) {
          db.exec(`ALTER TABLE server_packages ADD COLUMN ${name} ${type}`);
          if (from) db.exec(`UPDATE server_packages SET ${name}=${from}`);
        }
      const { sql } = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='server_packages'")
        .get();
      // A table from before the choose-program state: its CHECK cannot be altered.
      if (!sql.includes("'choosing'")) {
        const names = Object.values(columns).concat("server_id", "updated_at").join(",");
        db.exec(schema("server_packages_next"));
        db.exec(
          `INSERT INTO server_packages_next(${names}) SELECT ${names} FROM server_packages`,
        );
        db.exec("DROP TABLE server_packages");
        db.exec("ALTER TABLE server_packages_next RENAME TO server_packages");
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    this.orphaned = () => false;
  }
```

`computedStatus` gains the `choosing` case (after the orphan line):

```js
if (row.status === "choosing")
  return row.installId && readInstall(this.dataDir, row.installId, row.lockDigest)
    ? "choosing"
    : "missing";
```

One query per list:

```js
  /** Every record by server id: one query for a whole list. */
  byServer() {
    return new Map(this.all().map((row) => [row.serverId, row]));
  }
  publicFields(serverId, rows) {
    const row = rows ? (rows.get(serverId) ?? null) : this.get(serverId);
    if (!row) return {};
    // ...unchanged body from Task 4...
  }
  definitionFields(serverId, rows) {
    const row = rows ? (rows.get(serverId) ?? null) : this.get(serverId);
    // ...unchanged body...
  }
```

`server/features/mcp-servers/mcp-server-store.js`: `publicServer(row, packages)` passes `this.packages.publicFields(row.id, packages)`; `list()` does `const packages = this.packages.byServer();` and maps `(row) => this.publicServer(row, packages)`; `definitions()` builds the map once and calls `this.packages.definitionFields(row.id, packages)`. In `create`, normalise the flag first:

```js
  create(input, { bind = [], pendingCommand = false, packageRecord = null } = {}) {
    const pending = pendingCommand === true;
    requireLiteralValues(input);
    if (pending && (input?.transport !== "stdio" || input.command !== undefined))
      throw invalid();
    if (packageRecord && !pending) throw invalid();
    const fields = this.definition(input, pending);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/mcp-package-records-migration.test.js tests/unit/mcp-package-records.test.js tests/unit/mcp-package-cli-status.test.js tests/integration/mcp-packages-service.test.js tests/integration/mcp-packages-service-recovery.test.js && wc -l server/features/mcp-servers/mcp-server-store.js`
Expected: PASS; store ≤ 600 lines.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write server/features/mcp-packages/package-records.js server/features/mcp-servers/mcp-server-store.js tests/unit/mcp-package-records-migration.test.js tests/unit/mcp-package-records.test.js
git add server/features/mcp-packages/package-records.js server/features/mcp-servers/mcp-server-store.js tests/unit/mcp-package-records-migration.test.js tests/unit/mcp-package-records.test.js
git commit -m "fix: migrate MCP package records in one transaction and list them in one query

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Choose the program after a build — server (owner decision 1)

**Files:**

- Create: `server/features/mcp-packages/program-choice.js`
- Modify: `server/features/mcp-packages/package-install-job.js` (`choosing` result)
- Modify: `server/features/mcp-packages/package-store.js` (`rewriteReceipt`)
- Modify: `server/features/mcp-packages/mcp-packages.js` (`status`, `chooseProgram`)
- Modify: `server/http/routes/mcp-packages.js` (route + audit)
- Modify: `tests/helpers/pypi-index-fixture.js` (sdist with several scripts)
- Test: `tests/unit/mcp-program-choice.test.js`, `tests/integration/mcp-packages-routes.test.js`, `tests/integration/mcp-python-packages.test.js` (gated)

**Interfaces:**

- Consumes: `activate(..., { signal })` (Task 2), `switching` shape (Task 4), status `choosing` (Task 5).
- Produces: `chooseInstalledProgram(service, id, wanted) → job snapshot`; `choosablePrograms(service, id) → string[]`; `rewriteReceipt(dataDir, installId, receipt)`; `McpPackages#chooseProgram(id, wanted)`; `status(id)` → `{ source, job, error, programs }`; route `POST /mcp-servers/:id/package/program`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mcp-program-choice.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { harness, source } from "../helpers/mcp-packages-harness.js";

/** A preview without programs whose install (a build) names two. */
const builtTwo = (installs = []) => ({
  toolchainKind: "node",
  preview: async () => ({
    integrity: "sha256:a",
    programs: [],
    needsScripts: false,
    manifestText: "x==1\n",
    lockText: "x==1 --hash=sha256:a\n",
    digest: "d",
    dependencies: [],
  }),
  checkStored: () => ({ digest: "d", dependencies: [] }),
  manifestText: () => "x==1\n",
  install: async ({ preview }) => installs.push(preview),
  programsAfterInstall: () => [
    { name: "a-server", path: "a-server" },
    { name: "b-server", path: "b-server" },
  ],
  command: (_dataDir, receipt) => ({
    command: `/bin/${receipt.program.name}`,
    leading: [],
  }),
  toolchainVersion: () => "1.0",
});

async function choosing(t) {
  const installs = [];
  const h = harness(t, { adapters: { npm: builtTwo(installs) } });
  const { previewId } = await h.service.preview(source);
  await h.service.attach("s1", { source, previewId });
  await h.service.jobs.idle();
  return { ...h, installs };
}

test("a build with several programs waits for the owner's choice", async (t) => {
  const { service, records, rows } = await choosing(t);
  const row = records.get("s1");
  assert.equal(row.status, "choosing");
  assert.match(row.installId, /^[0-9a-f-]{36}$/);
  assert.equal(service.jobs.get("s1").state, "done");
  // The own command still runs; nothing was switched.
  assert.equal(rows.get("s1").command, "own");
  assert.deepEqual(service.status("s1").programs, ["a-server", "b-server"]);
});

test("choosing a program activates the install without a rebuild", async (t) => {
  const { service, records, rows, installs } = await choosing(t);
  service.chooseProgram("s1", "b-server");
  await service.jobs.idle();
  assert.equal(installs.length, 1, "no second install");
  const row = records.get("s1");
  assert.equal(row.status, "ready");
  assert.equal(row.program, "b-server");
  assert.equal(rows.get("s1").command, "/bin/b-server");
  assert.deepEqual(rows.get("s1").args, ["--flag"]);
  assert.deepEqual(service.status("s1").programs, []);
});

test("an unknown or missing program is refused before any job", async (t) => {
  const { service } = await choosing(t);
  assert.throws(() => service.chooseProgram("s1", "nope"), {
    code: "MCP_PACKAGE_PROGRAM_REQUIRED",
  });
  assert.throws(() => service.chooseProgram("s1", undefined), {
    code: "MCP_PACKAGE_PROGRAM_REQUIRED",
  });
  assert.throws(() => service.chooseProgram("s1", 7), {
    code: "MCP_PACKAGE_PROGRAM_REQUIRED",
  });
});

test("a server that is not choosing refuses a choice", async (t) => {
  const { service } = harness(t);
  assert.throws(() => service.chooseProgram("s1", "x"), { code: "MCP_PACKAGE_INVALID" });
});

test("a choosing record without its install is missing and refuses a choice", async (t) => {
  const { service, records, dataDir } = await choosing(t);
  fs.rmSync(path.join(dataDir, "mcp-packages", "installs", records.get("s1").installId), {
    recursive: true,
  });
  assert.throws(() => service.chooseProgram("s1", "a-server"), {
    code: "MCP_PACKAGE_INVALID",
  });
});

test("a program named before the install still decides at once", async (t) => {
  const h = harness(t, { adapters: { npm: builtTwo() } });
  const { previewId } = await h.service.preview(source);
  await h.service.attach("s1", { source, previewId, program: "a-server" });
  await h.service.jobs.idle();
  assert.equal(h.records.get("s1").status, "ready");
  assert.equal(h.records.get("s1").program, "a-server");
});
```

(The harness's `records` has no `computedStatus`; `chooseInstalledProgram` checks the receipt itself with `readInstall`, so the "missing" refusal test works on the harness too.)

Append to `tests/integration/mcp-packages-routes.test.js`:

```js
test("choosing a program answers 202 with the job and audits the activation", async (t) => {
  const seen = [];
  const { request, audit } = await app(t, {
    mcpPackages: {
      chooseProgram: (id, program) => {
        seen.push([id, program]);
        return { kind: "activate", state: "running", code: null, log: "" };
      },
    },
  });
  const response = await request("POST", "/api/mcp-servers/s1/package/program", {
    program: "b-server",
  });
  assert.equal(response.status, 202);
  assert.equal(response.body.job.state, "running");
  assert.deepEqual(seen, [["s1", "b-server"]]);
  assert.equal(audit.at(-1).action, "package.activated");
  assert.deepEqual(audit.at(-1).details, {
    registry: "npm",
    name: "x",
    version: "1.0.0",
    allowScripts: false,
    constraints: [],
  });
});
```

Gated real-uv test, append to `tests/integration/mcp-python-packages.test.js`:

```js
test(
  "an sdist with two scripts waits for the program choice and then starts",
  { skip },
  async (t) => {
    const s = await pythonPackageService(t, [
      {
        name: "two-c",
        version: "1.0",
        scripts: ["two-a", "two-b"],
        sdist: "c-extension",
      },
      { name: "setuptools", version: "84.0.0", file: await pinnedSetuptools() },
    ]);
    const { server } = await createPython(s, "two-c", { allowScripts: true });
    assert.equal(server.source.status, "choosing", s.packages.jobs.get(server.id)?.log);
    assert.deepEqual(s.packages.status(server.id).programs, ["two-a", "two-b"]);
    const compiles = s.calls.length;
    s.packages.chooseProgram(server.id, "two-b");
    await s.packages.jobs.idle();
    const ready = s.servers.get(server.id);
    assert.equal(ready.source.status, "ready");
    assert.equal(ready.source.program, "two-b");
    assert.equal(s.calls.length, compiles, "no uv run after the choice");
    assert.equal(
      execFileSync(ready.command, { env: { PATH: "/usr/bin:/bin" } })
        .toString()
        .trim(),
      "built",
    );
  },
);
```

In `tests/helpers/pypi-index-fixture.js` `sdistBuilder`, replace the `setup.py` entry so several scripts are possible:

```python
    "setup.py": "from setuptools import setup, Extension\nsetup(name=%r, version=%r, packages=[%r], ext_modules=[Extension(%r, [%r])], entry_points={'console_scripts': %r})\n"
        % (spec["name"], spec["version"], m, m + "._hello", m + "/_hello.c", ["%s = %s:main" % (s, m) for s in spec.get("scripts", [spec.get("script")])]),
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/mcp-program-choice.test.js tests/integration/mcp-packages-routes.test.js`
Expected: FAIL — the attach ends `failed` with `MCP_PACKAGE_PROGRAM_REQUIRED`; `chooseProgram is not a function`; route 404.

- [ ] **Step 3: The install stops at `choosing`**

`server/features/mcp-packages/package-store.js`:

```js
/** Replaces the receipt of a committed install (the program chosen after a build). */
export function rewriteReceipt(dataDir, installId, receipt) {
  const directory = verifiedInstall(dataDir, installId);
  writePrivate(path.join(directory, "receipt.json"), receipt);
}
```

`server/features/mcp-packages/package-install-job.js` in `runInstall`, replace the `installed`/`chosen`/`receipt` block and the code up to `activate`:

```js
// Some packages name their programs for sure only once installed (and built).
const installed = adapter.programsAfterInstall(stage, ref);
const wanted = program?.name || undefined;
// Several programs and none named yet: the owner picks one in the status panel.
const choosing = !!installed && installed.length > 1 && wanted === undefined;
const chosen = choosing ? null : installed ? chooseProgram(installed, wanted) : program;
const receipt = {
  ...ref,
  integrity: preview.integrity,
  lockDigest: checked.digest,
  allowScripts: preview.allowScripts,
  needsScripts: preview.needsScripts === true,
  constraints: preview.constraints ?? [],
  program: chosen,
  ...(installed ? { programs: installed } : {}),
  toolchain: {
    kind: adapter.toolchainKind,
    version: adapter.toolchainVersion(toolchain),
    directory: toolchainDir,
  },
};
stopIfCancelled(signal);
commitInstall(service.dataDir, { installId, stage, receipt });
if (choosing) {
  // The server keeps what it runs now; only the record learns the new install.
  service.records.put(serverId, {
    ...sourceFields(preview, null),
    installId,
    leadingArgs: service.storedLeading(serverId, service.records.get(serverId)),
    toolchainDir,
    status: "choosing",
    errorCode: null,
  });
  return;
}
```

(the existing `adapter.command(...)` and `activate(...)` follow unchanged).

- [ ] **Step 4: Choosing activates the committed install**

`server/features/mcp-packages/program-choice.js`:

```js
import { packageProblem } from "./package-errors.js";
import { activate, installError } from "./package-install-job.js";
import { readInstall, rewriteReceipt } from "./package-store.js";
import { chooseProgram } from "./program-select.js";

/** The receipt of a `choosing` record whose install is still there, else null. */
function choosingReceipt(service, id) {
  const row = service.records.get(id);
  if (row?.status !== "choosing" || !row.installId) return null;
  const receipt = readInstall(service.dataDir, row.installId, row.lockDigest);
  return Array.isArray(receipt?.programs) ? { row, receipt } : null;
}

/** The programs the owner may choose from; none unless the record is `choosing`. */
export function choosablePrograms(service, id) {
  return choosingReceipt(service, id)?.receipt.programs.map((p) => p.name) ?? [];
}

/**
 * Activates the program `wanted` of a build that named several (owner decision 1):
 * the install stays, only its receipt, the record and the server command change.
 */
export function chooseInstalledProgram(service, id, wanted) {
  const found = choosingReceipt(service, id);
  if (!found) throw packageProblem("MCP_PACKAGE_INVALID", 400);
  service.requireIdle(id);
  const { row, receipt } = found;
  const chosen = chooseProgram(
    receipt.programs,
    typeof wanted === "string" && wanted ? wanted : undefined,
  );
  return service.jobs.run(
    id,
    { kind: "activate", installId: row.installId },
    async (_log, note, signal) => {
      try {
        note({ toolchainDir: row.toolchainDir });
        const adapter = service.adapterOf(row.registry);
        const toolchain = await service.toolchain(adapter.toolchainKind);
        const next = { ...receipt, program: chosen };
        rewriteReceipt(service.dataDir, row.installId, next);
        const { command, leading } = adapter.command(
          service.dataDir,
          { ...next, installId: row.installId },
          toolchain,
        );
        await activate(
          service,
          id,
          {
            ...row,
            program: chosen.name,
            programPath: chosen.path,
            leadingArgs: leading.length,
            status: "ready",
            errorCode: null,
          },
          command,
          leading,
          { signal },
        );
      } catch (error) {
        // activate() restored the choosing record; the owner can choose again.
        throw installError(error);
      }
    },
  );
}
```

`server/features/mcp-packages/mcp-packages.js`:

```js
import { chooseInstalledProgram, choosablePrograms } from "./program-choice.js";
```

```js
  /** Activates one program of a build that named several (status `choosing`). */
  chooseProgram(id, wanted) {
    return chooseInstalledProgram(this, id, wanted);
  }
```

and `status(id)` returns `programs: choosablePrograms(this, id)` in both return statements.

`server/http/routes/mcp-packages.js`, after the reinstall route:

```js
router.post("/mcp-servers/:id/package/program", (req, res) => {
  const body = record(req.body) ? req.body : {};
  const job = packages().chooseProgram(req.params.id, body.program);
  auditMcp(
    "package.activated",
    req.params.id,
    auditDetails(services.mcpServers.get(req.params.id).source),
  );
  res.status(202).json({ job });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/unit/mcp-program-choice.test.js tests/unit/mcp-packages-service.test.js tests/integration/mcp-packages-routes.test.js tests/unit/audit-schema.test.js && AGENTPIER_MCP_PYTHON_TESTS=1 node --test tests/integration/mcp-python-packages.test.js`
Expected: PASS (the gated run downloads the managed toolchain once; skip it only if the machine has no network, and say so in the PR).

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write server/features/mcp-packages server/http/routes/mcp-packages.js tests/unit/mcp-program-choice.test.js tests/integration/mcp-packages-routes.test.js tests/integration/mcp-python-packages.test.js tests/helpers/pypi-index-fixture.js
git add server/features/mcp-packages server/http/routes/mcp-packages.js tests
git commit -m "feat: let the owner choose the program of a build with several

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Choose the program — UI, i18n and docs

**Files:**

- Create: `web/features/mcp-servers/McpPackageProgramChoice.jsx`
- Modify: `web/features/mcp-servers/McpPackagePanel.jsx`
- Modify: `web/features/assistants/assistant-api.js`
- Modify: `web/lib/i18n/de/mcp-packages.js`, `web/lib/i18n/en/mcp-packages.js`
- Modify: `tests/browser/mcp-packages-pypi.spec.js`
- Modify: `docs/mcp.md`

**Interfaces:**

- Consumes: `GET .../package` → `programs`; `POST .../package/program` (Task 6).
- Produces: `assistantApi.chooseMcpPackageProgram(id, { program })`; copy keys `status.choosing`, `choosingHint`, `chooseProgram`.

- [ ] **Step 1: Write the failing browser test**

Append to `tests/browser/mcp-packages-pypi.spec.js`:

```js
test("a build with several programs waits for the program choice", async ({ page }) => {
  const server = pypiServer();
  server.source = { ...server.source, status: "choosing", program: "", leadingArgs: 0 };
  const state = await packageSetup(page, { servers: [server] });
  state.versions = pypiVersions;
  state.packageStatus = {
    source: server.source,
    job: { kind: "install", state: "done", code: null, log: "" },
    error: null,
    programs: ["opnsense-mcp", "opnsense-admin"],
  };
  state.reply = ({ path }) =>
    path.endsWith("/package/program")
      ? {
          status: 202,
          json: { job: { kind: "activate", state: "running", code: null, log: "" } },
        }
      : null;
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  const panel = dialog.getByRole("region", { name: "Package" });
  await expect(
    panel.getByRole("status").filter({ hasText: "Choose program" }),
  ).toBeVisible();
  await expect(panel.getByText(/several programs/)).toBeVisible();
  const select = panel.getByLabel("Program", { exact: true });
  await expect(select).toHaveValue("opnsense-mcp");
  await select.selectOption("opnsense-admin");
  await panel.getByRole("button", { name: "Use this program" }).click();
  await expect(
    panel.getByRole("status").filter({ hasText: "Installing…" }),
  ).toBeVisible();
  expect(writes(state, "/api/mcp-servers/s1/package/program")[0].body).toEqual({
    program: "opnsense-admin",
  });
  // The bindings stay locked until the program runs.
  await expect(dialog.getByText(/added once the package is installed/)).toBeVisible();
});

test("German: the program choice is translated", async ({ page }) => {
  const server = pypiServer();
  server.source = { ...server.source, status: "choosing", program: "", leadingArgs: 0 };
  const state = await packageSetup(page, { servers: [server], language: "de" });
  state.versions = pypiVersions;
  state.packageStatus = {
    source: server.source,
    job: null,
    error: null,
    programs: ["opnsense-mcp", "opnsense-admin"],
  };
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  const panel = dialog.getByRole("region", { name: "Paket" });
  await expect(
    panel.getByRole("status").filter({ hasText: "Programm wählen" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Dieses Programm verwenden" }),
  ).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx playwright test tests/browser/mcp-packages-pypi.spec.js --project=desktop -g "program choice|several programs"`
Expected: FAIL — status shows `choosing` raw, no select.

- [ ] **Step 3: Catalogs (de + en, same keys)**

`web/lib/i18n/en/mcp-packages.js`: in `status` add `choosing: "Choose program",`; add

```js
  choosingHint:
    "The build installed several programs. Choose the one this server starts; nothing is installed again.",
  chooseProgram: "Use this program",
```

`web/lib/i18n/de/mcp-packages.js`: in `status` add `choosing: "Programm wählen",`; add

```js
  choosingHint:
    "Der Build hat mehrere Programme installiert. Wähle das Programm, das dieser Server startet; nichts wird erneut installiert.",
  chooseProgram: "Dieses Programm verwenden",
```

- [ ] **Step 4: API and component**

`web/features/assistants/assistant-api.js` after `reinstallMcpPackage`:

```js
  chooseMcpPackageProgram: (id, input) =>
    api(`/mcp-servers/${encodeURIComponent(id)}/package/program`, "POST", input),
```

`web/features/mcp-servers/McpPackageProgramChoice.jsx`:

```jsx
import React, { useId, useState } from "react";
import { mcpPackageCopy as copy } from "../../lib/i18n/messages/mcp-packages.js";

/** The programs a build installed; choosing one activates it without a rebuild. */
export default function McpPackageProgramChoice({ programs, busy, onChoose }) {
  const id = useId();
  const [program, setProgram] = useState(programs[0] || "");
  return (
    <div className="mcp-package-update">
      <p className="mcp-hint">{copy.choosingHint}</p>
      <div className="mcp-field">
        <label htmlFor={id}>{copy.programLabel}</label>
        <select
          id={id}
          value={program}
          onChange={(event) => setProgram(event.target.value)}
        >
          {programs.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="mcp-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy || !program}
          onClick={() => onChoose(program)}
        >
          {copy.chooseProgram}
        </button>
      </div>
    </div>
  );
}
```

`web/features/mcp-servers/McpPackagePanel.jsx`: import it, add

```js
const choose = (program) =>
  act(async () =>
    started(await assistantApi.chooseMcpPackageProgram(server.id, { program })),
  );
```

render, after the failed/missing Reinstall block:

```jsx
{
  shown === "choosing" && (status?.programs?.length ?? 0) > 0 && (
    <McpPackageProgramChoice programs={status.programs} busy={busy} onChoose={choose} />
  );
}
```

and hide the update form while choosing: `{!running && !preview && shown !== "choosing" && (`. Also add `"choosing"` to the Reinstall condition only when no programs could be read: `(shown === "failed" || shown === "missing" || (shown === "choosing" && !status?.programs?.length))`.

`McpServerFields.jsx` needs no change: `notReady` is any status other than `ready`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/unit/i18n-catalogs.test.js && npm run build && npx playwright test tests/browser/mcp-packages-pypi.spec.js tests/browser/mcp-packages.spec.js --project=desktop`
Expected: PASS.

- [ ] **Step 6: Docs**

`docs/mcp.md`, in **Source builds (PyPI)** replace "A source-only package with several programs cannot pick its program in the form yet: its build fails with "program required"." with:

```markdown
A source-only package whose build installs several programs stops at _Choose
program_: the package panel lists the programs, and **Use this program** starts the
chosen one without installing again.
```

and in the status sentence: "The form shows the status: _Installing…_, _Installed_, _Choose program_, _Installation failed_ or _Installation missing_ …". Add to the **Audit** bullet: "choosing the program after a build is recorded as `package.activated`".

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write web/features/mcp-servers/McpPackageProgramChoice.jsx web/features/mcp-servers/McpPackagePanel.jsx web/features/assistants/assistant-api.js web/lib/i18n/de/mcp-packages.js web/lib/i18n/en/mcp-packages.js tests/browser/mcp-packages-pypi.spec.js docs/mcp.md
git add web tests/browser/mcp-packages-pypi.spec.js docs/mcp.md
git commit -m "feat: offer the program choice of a multi-program build in the package panel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: npm and registry hardening

**Files:**

- Modify: `server/features/mcp-packages/registry-metadata.js`, `lock-check.js`, `npm-package-install.js`, `package-store.js`
- Modify: `server/features/operations/release-download.js` (`pinOrigin`)
- Test: `tests/unit/mcp-registry-metadata.test.js`, `tests/unit/mcp-lock-check.test.js`, `tests/unit/mcp-package-store.test.js`, `tests/unit/mcp-packages-service.test.js`

**Interfaces:**

- Produces: `download(url, fetchImpl, limit, { pinOrigin = false, ... })` refuses a redirect to another origin (`code: "DOWNLOAD_ORIGIN_CHANGED"`); `registryDownload(url, fetchImpl = fetch)` exported from `registry-metadata.js`; `sri512` shape check in `checkNpmLock`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mcp-registry-metadata.test.js` (add `registryDownload, npmPackument` to the import):

```js
const redirect = (location) => ({
  status: 302,
  ok: false,
  headers: new Headers({ location }),
  body: { cancel: async () => {} },
});
const notFound = { status: 404, ok: false, headers: new Headers(), body: null };

test("registry metadata follows redirects only on its own origin", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.endsWith("/a")) return redirect("https://registry.npmjs.org/b");
    if (url.endsWith("/b")) return notFound;
    return redirect("https://evil.example/x");
  };
  await assert.rejects(registryDownload("https://registry.npmjs.org/a", fetchImpl), {
    status: 404,
  });
  assert.deepEqual(seen, [
    "https://registry.npmjs.org/a",
    "https://registry.npmjs.org/b",
  ]);
  await assert.rejects(registryDownload("https://registry.npmjs.org/c", fetchImpl), {
    code: "DOWNLOAD_ORIGIN_CHANGED",
  });
  assert.equal(seen.includes("https://evil.example/x"), false);
});

test("a scoped npm name keeps its @ and encodes its slash", async () => {
  const urls = [];
  await npmPackument("@scope/server-x", {
    registry: "https://registry.npmjs.org",
    download: async (url) => {
      urls.push(url);
      return Buffer.from("{}");
    },
  });
  assert.deepEqual(urls, ["https://registry.npmjs.org/@scope%2Fserver-x"]);
});

test("version info reads only own version keys", () => {
  const inherited = Object.create({ "1.0.0": { dist: { integrity: "sha512-x" } } });
  assert.throws(() => npmVersionInfo({ versions: inherited }, "1.0.0"), {
    code: "MCP_PACKAGE_VERSION_NOT_FOUND",
  });
  assert.throws(() => npmVersionInfo({ versions: {} }, "constructor"), {
    code: "MCP_PACKAGE_VERSION_NOT_FOUND",
  });
});
```

`tests/unit/mcp-lock-check.test.js`: make the fixture integrities valid SRI values and add a shape test:

```js
import { createHash } from "node:crypto";
const sri = (name) => `sha512-${createHash("sha512").update(name).digest("base64")}`;
```

Replace every `` `sha512-${name}` `` with `sri(name)` and every `"sha512-server-x"` / `"sha512-a"` / `"sha512-other"` with `sri("server-x")` / `sri("a")` / `sri("other")`. Then:

```js
test("an integrity that is not one full sha512 value is foreign", () => {
  for (const bad of [
    "sha512-short",
    `${sri("zod")} sha1-abc`,
    `${sri("zod")}\n`,
    `sha512-${"A".repeat(87)}=`,
  ])
    assert.throws(
      () =>
        checkNpmLock(
          lock({ "node_modules/zod": entry("zod", "3.0.0", { integrity: bad }) }),
          {
            ref,
            integrity: sri("server-x"),
            registry,
          },
        ),
      { code: "MCP_PACKAGE_FOREIGN_SOURCE" },
      bad,
    );
});
```

`tests/unit/mcp-package-store.test.js` (import `pruneInstalls` if not yet):

```js
test("pruning never follows a linked installs folder", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-prune-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-prune-outside-"));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(outside, "keep.txt"), "x");
  fs.mkdirSync(path.join(dataDir, "mcp-packages"), { recursive: true });
  fs.symlinkSync(outside, path.join(dataDir, "mcp-packages", "installs"));
  pruneInstalls(dataDir, new Set());
  assert.equal(fs.existsSync(path.join(outside, "keep.txt")), true);
});
```

`tests/unit/mcp-packages-service.test.js`:

```js
test("an install whose top package has another name fails", async (t) => {
  // The folder says x, its manifest names another package.
  const { service, records } = harness(t, { installedName: "y" });
  await attach(service);
  await service.jobs.idle();
  assert.equal(records.get("s1").status, "failed");
  assert.equal(service.jobs.get("s1").code, "MCP_PACKAGE_INSTALL_FAILED");
});
```

For this, give `tests/helpers/mcp-packages-harness.js` the option `installedName = "x"` (add it to the destructured options) and write `JSON.stringify({ name: installedName, version: "1.0.0" })` as the installed `package.json`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/mcp-registry-metadata.test.js tests/unit/mcp-lock-check.test.js tests/unit/mcp-package-store.test.js tests/unit/mcp-packages-service.test.js`
Expected: FAIL — `registryDownload` missing, short integrities accepted, the linked folder emptied, `y` installs as ready.

- [ ] **Step 3: Implement**

`server/features/operations/release-download.js`: add `pinOrigin = false` to the `download` options, pass it to `transfer(url, fetchImpl, limit, idleTimeout, state, headers, pinOrigin)`, and in `transfer`:

```js
async function transfer(url, fetchImpl, limit, idleTimeout, state, extraHeaders, pinOrigin) {
  const origin = new URL(url).origin;
```

inside the redirect loop, after the https check:

```js
// Registry metadata never leaves the registry it was asked for.
if (pinOrigin && target.origin !== origin)
  throw failure(serverMessages.releases.downloadFailed, "DOWNLOAD_ORIGIN_CHANGED", 502);
```

`server/features/mcp-packages/registry-metadata.js`:

```js
/** The default metadata download: JSON, size-capped, redirects only on the same origin. */
export const registryDownload = (url, fetchImpl = fetch) =>
  fetchDownload(url, fetchImpl, metadataLimit, {
    headers: { accept: "application/json" },
    pinOrigin: true,
  });
```

and `fetchRegistryJson(url, { download = registryDownload } = {})` (remove `defaultDownload`). `npmVersionInfo`:

```js
export function npmVersionInfo(packument, version) {
  const versions = packument?.versions;
  const info =
    versions && typeof versions === "object" && Object.hasOwn(versions, version)
      ? versions[version]
      : null;
  if (!info || typeof info !== "object")
    throw packageProblem("MCP_PACKAGE_VERSION_NOT_FOUND", 404);
```

`server/features/mcp-packages/lock-check.js`:

```js
// One SRI sha512 value: 64 bytes are 86 base64 characters plus "==".
const sha512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
```

and replace `!entry.integrity.startsWith("sha512-")` with `!sha512.test(entry.integrity)`.

`server/features/mcp-packages/npm-package-install.js`:

```js
if (installed?.name !== ref.name || installed?.version !== ref.version) throw failed();
```

`server/features/mcp-packages/package-store.js` `pruneInstalls`:

```js
export function pruneInstalls(dataDir, keep) {
  const root = path.join(dataDir, "mcp-packages", "installs");
  let names;
  try {
    // Never through a link: a moved or replaced folder is left alone.
    for (const dir of [path.dirname(root), root])
      if (!fs.lstatSync(dir).isDirectory()) return;
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const id = name.replace(/^\.stage-/, "");
    if (!keep.has(id)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}
```

(`lstat(...).isDirectory()` is false for a symlink.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/mcp-registry-metadata.test.js tests/unit/mcp-lock-check.test.js tests/unit/mcp-package-store.test.js tests/unit/mcp-packages-service.test.js tests/integration/mcp-npm-install.test.js tests/integration/mcp-packages-service.test.js tests/integration/release-preview.test.js`
Expected: PASS (the npm registry fixture already serves real SRI values).

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write server/features/mcp-packages server/features/operations/release-download.js tests/unit/mcp-registry-metadata.test.js tests/unit/mcp-lock-check.test.js tests/unit/mcp-package-store.test.js tests/unit/mcp-packages-service.test.js tests/helpers/mcp-packages-harness.js
git add server tests
git commit -m "fix: pin npm registry redirects and check lock integrity and package names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: PyPI metadata

**Files:**

- Create: `server/features/mcp-packages/pep440.js`
- Modify: `server/features/mcp-packages/registry-metadata.js`, `python-adapter.js`
- Test: `tests/unit/mcp-pep440.test.js`, `tests/unit/mcp-registry-metadata.test.js`, `tests/unit/mcp-python-adapter.test.js`

**Interfaces:**

- Produces: `comparePep440(a, b) → -1|0|1` for versions `pypiVersionPattern` accepts; `maxReleaseFiles = 512` in `python-adapter.js`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mcp-pep440.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { comparePep440 } from "../../server/features/mcp-packages/pep440.js";

test("PEP 440 order: dev, pre, final, post; epochs and zero padding", () => {
  const ascending = [
    "1.0.dev1",
    "1.0a1.dev1",
    "1.0a1",
    "1.0a1.post1",
    "1.0a2",
    "1.0b1",
    "1.0rc1",
    "1.0",
    "1.0.post1.dev1",
    "1.0.post1",
    "1.0.1",
    "1.10",
    "1!0.1",
  ];
  const shuffled = [...ascending].reverse();
  assert.deepEqual(shuffled.sort(comparePep440), ascending);
  assert.equal(comparePep440("1.0", "1.0.0"), 0);
  assert.equal(comparePep440("1.0RC1", "1.0rc1"), 0);
  assert.equal(comparePep440("99999999999999999999.0", "99999999999999999998.0"), 1);
});
```

`tests/unit/mcp-registry-metadata.test.js`:

```js
test("PyPI versions with the same upload time sort by PEP 440", () => {
  const at = "2026-01-01T00:00:00Z";
  const listed = pypiVersions({
    info: { version: "1.0" },
    releases: {
      "1.0rc1": [file("a.whl", "bdist_wheel", "a", at)],
      "1.0": [file("b.whl", "bdist_wheel", "b", at)],
      "1.0.post1": [file("c.whl", "bdist_wheel", "c", at)],
    },
  }).versions.map((v) => v.version);
  assert.deepEqual(listed, ["1.0.post1", "1.0", "1.0rc1"]);
});

test("PyPI versions longer than 128 characters are not listed", () => {
  const long = `1.${"0".repeat(130)}`;
  const listed = pypiVersions({
    info: {},
    releases: { [long]: [file("a.whl", "bdist_wheel", "a", "2026-01-01T00:00:00Z")] },
  });
  assert.deepEqual(listed.versions, []);
});

test("a PyPI answer without releases is a registry failure, not an empty list", (t) => {
  const errors = t.mock.method(console, "error", () => {});
  assert.throws(() => pypiVersions({ info: { version: "1.0" } }), {
    code: "MCP_PACKAGE_REGISTRY_UNAVAILABLE",
  });
  assert.throws(() => pypiVersionInfo({ info: {}, releases: [] }, "1.0"), {
    code: "MCP_PACKAGE_REGISTRY_UNAVAILABLE",
  });
  assert.match(String(errors.mock.calls[0].arguments[0]), /releases/);
});

test("pypiProject refuses a name that is not a PyPI name before any request", async () => {
  let requests = 0;
  const download = async () => {
    requests += 1;
    return Buffer.from("{}");
  };
  for (const name of ["../x", "a/b", "", "x".repeat(201)])
    await assert.rejects(pypiProject(name, { download }), {
      code: "MCP_PACKAGE_INVALID",
    });
  assert.equal(requests, 0);
});
```

`tests/unit/mcp-python-adapter.test.js` (uses the file's `sha`, `file`, `lockOf`, `ref` and `setup` helpers):

```js
test("a stored integrity longer than 512 digests is refused", () => {
  const digests = Array.from({ length: 513 }, (_, i) => sha(`file ${i}`));
  const integrity = digests.map((digest) => `sha256:${digest}`).join(" ");
  assert.throws(
    () => pythonAdapter.checkStored({ lockText: lockOf(digests[0]), ref, integrity }),
    { code: "MCP_PACKAGE_INTEGRITY_MISMATCH" },
  );
});

test("a release with more than 512 trusted files is refused at preview", async (t) => {
  const files = Array.from({ length: 513 }, (_, i) =>
    file(`srv_x-1.0-${i}.tar.gz`, Buffer.from(`sdist ${i}`)),
  );
  const { preview } = setup(t, { files, lock: lockOf(sha("sdist 0")) });
  await assert.rejects(preview(), { code: "MCP_PACKAGE_INSTALL_FAILED" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/mcp-pep440.test.js tests/unit/mcp-registry-metadata.test.js tests/unit/mcp-python-adapter.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`server/features/mcp-packages/pep440.js`:

```js
const parts =
  /^(?:(\d+)!)?(\d+(?:\.\d+)*)(?:(a|b|rc)(\d+))?(?:\.post(\d+))?(?:\.dev(\d+))?$/i;
const preRank = { a: 0n, b: 1n, rc: 2n };
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The PEP 440 sort key of a version `pypiVersionPattern` accepts (BigInt: no size limit). */
function key(version) {
  const [, epoch = "0", release, pre, preNumber, post, dev] = parts.exec(version);
  const numbers = release.split(".").map(BigInt);
  while (numbers.length > 1 && numbers.at(-1) === 0n) numbers.pop();
  return {
    epoch: BigInt(epoch),
    release: numbers,
    // A dev release of a final sorts before its prereleases; a final after them.
    pre: pre
      ? [preRank[pre.toLowerCase()], BigInt(preNumber)]
      : post === undefined && dev !== undefined
        ? [-1n, 0n]
        : [3n, 0n],
    post: post === undefined ? -1n : BigInt(post),
    dev: dev === undefined ? null : BigInt(dev),
  };
}

/** Ascending PEP 440 order. */
export function comparePep440(a, b) {
  const x = key(a);
  const y = key(b);
  if (x.epoch !== y.epoch) return compare(x.epoch, y.epoch);
  for (let i = 0; i < Math.max(x.release.length, y.release.length); i++) {
    const diff = compare(x.release[i] ?? 0n, y.release[i] ?? 0n);
    if (diff) return diff;
  }
  for (let i = 0; i < 2; i++) {
    const diff = compare(x.pre[i], y.pre[i]);
    if (diff) return diff;
  }
  if (x.post !== y.post) return compare(x.post, y.post);
  if (x.dev === y.dev) return 0;
  if (x.dev === null) return 1;
  if (y.dev === null) return -1;
  return compare(x.dev, y.dev);
}
```

`server/features/mcp-packages/registry-metadata.js`:

```js
import { comparePep440 } from "./pep440.js";
import { canonicalPypiVersion, packageName, pypiVersionPattern } from "./package-spec.js";
```

Make the sorter take the version order:

```js
const newestFirst = (compare) => (a, b) => {
  if (a.publishedAt !== b.publishedAt) {
    if (a.publishedAt === null) return 1;
    if (b.publishedAt === null) return -1;
    const byTime = b.publishedAt.localeCompare(a.publishedAt);
    if (byTime) return byTime;
  }
  return compare(b.version, a.version) || b.version.localeCompare(a.version);
};
```

`npmVersions` sorts with `newestFirst(compareSemver)`, `pypiVersions` with `newestFirst(comparePep440)`. Add:

```js
/**
 * PyPI marks the JSON API's `releases` key deprecated. Its absence must not read as
 * "no versions": it fails loudly so a change of the API is noticed (docs/mcp.md).
 */
function releasesOf(project) {
  const releases = project?.releases;
  if (releases && typeof releases === "object" && !Array.isArray(releases))
    return releases;
  console.error(
    "AgentPier could not read PyPI releases (the JSON API returned no releases key).",
  );
  throw packageProblem("MCP_PACKAGE_REGISTRY_UNAVAILABLE", 502);
}
```

`pypiVersions` uses `Object.entries(releasesOf(project))` and filters `version.length <= 128 && pypiVersionPattern.test(version)`; `pypiRelease` starts with `const releases = releasesOf(project);`. `pypiProject`:

```js
export const pypiProject = (name, { registry = pypiRegistry, download } = {}) =>
  Promise.resolve().then(() =>
    fetchRegistryJson(
      `${registry}/pypi/${encodeURIComponent(packageName({ registry: "pypi", name }))}/json`,
      { download },
    ),
  );
```

`server/features/mcp-packages/python-adapter.js`:

```js
// The release files pinned in the stored integrity; a release with more is refused.
export const maxReleaseFiles = 512;
```

In `preview`, after the `!files.length` check:

```js
if (files.length > maxReleaseFiles)
  throw packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502);
```

In `digestsOf`, first line:

```js
// `sha256:<64 hex>` plus a space each: the bound of what a preview may store.
if (typeof integrity === "string" && integrity.length > maxReleaseFiles * 72)
  throw mismatch();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/mcp-pep440.test.js tests/unit/mcp-registry-metadata.test.js tests/unit/mcp-python-adapter.test.js tests/integration/mcp-packages-routes.test.js`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write server/features/mcp-packages tests/unit/mcp-pep440.test.js tests/unit/mcp-registry-metadata.test.js tests/unit/mcp-python-adapter.test.js
git add server/features/mcp-packages tests/unit
git commit -m "fix: order PyPI versions by PEP 440 and bound PyPI metadata

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: PyPI install — wheel reader, dist-info and constraints

**Files:**

- Create: `tests/helpers/zip-file.js`, `tests/unit/mcp-wheel-zip.test.js`
- Modify: `server/features/mcp-packages/wheel-programs.js`, `package-spec.js`
- Test: `tests/unit/mcp-wheel-programs.test.js`, `tests/unit/mcp-package-constraints.test.js`

- [ ] **Step 1: Write the failing tests**

`tests/helpers/zip-file.js`:

```js
import zlib from "node:zlib";

/** A stored (uncompressed) zip of `{ name: text }`, for the wheel reader tests. */
export function zipBytes(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const list = Object.entries(entries);
  for (const [name, text] of list) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
```

`tests/unit/mcp-wheel-zip.test.js` (real CPython, gated like the other real-uv tests):

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sharedPython } from "../helpers/mcp-python-service.js";
import { zipBytes } from "../helpers/zip-file.js";
import { wheelEntryPoints } from "../../server/features/mcp-packages/wheel-programs.js";

const skip = process.env.AGENTPIER_MCP_PYTHON_TESTS !== "1";
const scripts = "[console_scripts]\nsrv = srv:main\n";

async function read(t, entries) {
  const python = await sharedPython();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wheel-zip-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wheelFile = path.join(dir, "x.whl");
  fs.writeFileSync(wheelFile, zipBytes(entries));
  return wheelEntryPoints({ python, wheelFile });
}

test("the reader returns the one top-level entry_points.txt", { skip }, async (t) => {
  assert.equal(
    await read(t, {
      "srv-1.0.dist-info/entry_points.txt": scripts,
      "srv/__init__.py": "",
    }),
    scripts,
  );
});

test("two dist-info entry points or a nested one give nothing", { skip }, async (t) => {
  assert.equal(
    await read(t, {
      "srv-1.0.dist-info/entry_points.txt": scripts,
      "other-1.0.dist-info/entry_points.txt": scripts,
    }),
    "",
  );
  assert.equal(await read(t, { "a/srv-1.0.dist-info/entry_points.txt": scripts }), "");
});

test("an oversized entry_points.txt is not read", { skip }, async (t) => {
  assert.equal(
    await read(t, {
      "srv-1.0.dist-info/entry_points.txt": `${scripts}#${"x".repeat(1024 * 1024)}`,
    }),
    "",
  );
});
```

`tests/unit/mcp-wheel-programs.test.js` (uses the file's existing temp-dir helpers; `installedEntryPoints` is already imported there):

```js
test("a symlinked dist-info folder is not read", (t) => {
  const venv = fs.mkdtempSync(path.join(os.tmpdir(), "venv-"));
  t.after(() => fs.rmSync(venv, { recursive: true, force: true }));
  const site = path.join(venv, "lib", "python3.14", "site-packages");
  const real = path.join(venv, "elsewhere");
  fs.mkdirSync(site, { recursive: true });
  fs.mkdirSync(real);
  fs.writeFileSync(
    path.join(real, "entry_points.txt"),
    "[console_scripts]\nx = x:main\n",
  );
  fs.symlinkSync(real, path.join(site, "srv-1.0.dist-info"));
  assert.equal(installedEntryPoints(venv, "srv"), "");
});

test("two dist-info folders of one distribution give no program", (t) => {
  const venv = fs.mkdtempSync(path.join(os.tmpdir(), "venv-"));
  t.after(() => fs.rmSync(venv, { recursive: true, force: true }));
  const site = path.join(venv, "lib", "python3.14", "site-packages");
  for (const version of ["1.0", "2.0"]) {
    const dist = path.join(site, `srv-${version}.dist-info`);
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "entry_points.txt"),
      `[console_scripts]\nsrv${version[0]} = x:main\n`,
    );
  }
  assert.equal(installedEntryPoints(venv, "srv"), "");
});
```

`tests/unit/mcp-package-constraints.test.js`:

```js
test("a wildcard goes only after release numbers", () => {
  const ref = { registry: "pypi", name: "srv", version: "1.0" };
  assert.deepEqual(packageConstraints({ constraints: ["x==1.0.*", "y!=2.*"] }, ref), [
    "x==1.0.*",
    "y!=2.*",
  ]);
  for (const line of ["x==1.0a1.*", "x==1.0.post1.*", "x!=1.0.dev1.*", "x==1.0rc1.*"])
    assert.throws(
      () => packageConstraints({ constraints: [line] }, ref),
      {
        code: "MCP_PACKAGE_INVALID",
      },
      line,
    );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/mcp-wheel-programs.test.js tests/unit/mcp-package-constraints.test.js && AGENTPIER_MCP_PYTHON_TESTS=1 node --test tests/unit/mcp-wheel-zip.test.js`
Expected: the dist-info and constraint tests FAIL; the zip tests PASS already (they pin the reader's behaviour with real zips).

- [ ] **Step 3: Implement**

`server/features/mcp-packages/wheel-programs.js`, replace `installedEntryPoints`:

```js
/** A folder reached without a link. */
const realFolder = (dir) => {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The entry points of the installed distribution `name`: exactly one `.dist-info`
 * folder, found in sorted order and never through a link. Two copies (a leftover of
 * another version) or a linked one leave the program unknown.
 */
export function installedEntryPoints(venvDir, name) {
  const lib = path.join(venvDir, "lib");
  const found = [];
  for (const version of listing(lib).sort()) {
    const site = path.join(lib, version, "site-packages");
    for (const entry of listing(site).sort()) {
      if (!entry.endsWith(".dist-info")) continue;
      const dist = entry.slice(0, -".dist-info".length).replace(/-[^-]+$/, "");
      if (normalizePypiName(dist) === name) found.push(path.join(site, entry));
    }
  }
  return found.length === 1 && realFolder(found[0])
    ? regularText(path.join(found[0], "entry_points.txt"))
    : "";
}
```

`server/features/mcp-packages/package-spec.js`, the clause (PEP 440 and `packaging`: a wildcard never combines with a pre-, post- or dev-release):

```js
const clause = String.raw`(?:(?:==|!=)[ \t]*${release}(?:\.\*|${suffix})|~=[ \t]*\d+(?:\.\d+)+${suffix}|(?:<=|>=|<|>)[ \t]*${release}${suffix})`;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/mcp-wheel-programs.test.js tests/unit/mcp-package-constraints.test.js tests/unit/mcp-package-spec.test.js tests/unit/mcp-python-adapter.test.js && AGENTPIER_MCP_PYTHON_TESTS=1 node --test tests/unit/mcp-wheel-zip.test.js tests/integration/mcp-python-packages.test.js`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write tests/helpers/zip-file.js tests/unit/mcp-wheel-zip.test.js tests/unit/mcp-wheel-programs.test.js tests/unit/mcp-package-constraints.test.js server/features/mcp-packages/wheel-programs.js server/features/mcp-packages/package-spec.js
git add tests server/features/mcp-packages/wheel-programs.js server/features/mcp-packages/package-spec.js
git commit -m "fix: read one real dist-info folder and refuse wildcards after prereleases

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Preview failures name a reason

**Files:**

- Create: `web/features/mcp-servers/mcp-package-labels.js` (`refusalField` here; `showsPath` follows in Task 14)
- Modify: `server/features/mcp-packages/package-errors.js` (`MCP_PACKAGE_UNSATISFIABLE`)
- Modify: `server/lib/i18n/{de,en}/mcp-packages.js` (`unsatisfiable`, `previewFailed`)
- Modify: `server/features/mcp-packages/python-package-install.js`, `npm-package-install.js`, `mcp-packages.js`
- Modify: `web/features/mcp-servers/McpServerDetail.jsx`, `McpPackagePanel.jsx`
- Modify: `docs/mcp.md`
- Test: `tests/unit/mcp-python-install.test.js`, `tests/unit/mcp-package-errors.test.js`, `tests/unit/mcp-package-labels.test.js`, `tests/unit/mcp-package-previews.test.js`

**Interfaces:**

- Produces: `compileFailure(output) → "build" | "unsatisfiable" | "failed"` (exported from `python-package-install.js`); code `MCP_PACKAGE_UNSATISFIABLE` (400); message key `previewFailed`; `refusalField(error, registry) → "packageConstraints" | "packageVersion" | null`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mcp-python-install.test.js` (add `compileFailure` to the import):

```js
test("a failed compile is a needed build, an unsatisfiable graph or another failure", () => {
  assert.equal(
    compileFailure(
      "  × No solution found when resolving dependencies:\n  ╰─▶ Because x==1.0 has no\n      usable wheels and you require x==1.0, we can conclude",
    ),
    "build",
  );
  assert.equal(
    compileFailure(
      "  × No solution found when resolving dependencies:\n  ╰─▶ Because only helper-x<=2.0 is available and srv-y==1.0 depends on helper-x>=3",
    ),
    "unsatisfiable",
  );
  assert.equal(
    compileFailure("error: Failed to fetch: `http://127.0.0.1:1/simple/x/`"),
    "failed",
  );
});
```

and a resolve test with the file's `tmp`, `python`, `ref` and `failure` helpers:

```js
test("an unsatisfiable resolve is named as such, with or without the build", async (t) => {
  const conflict =
    "  × No solution found when resolving dependencies:\n  ╰─▶ Because only helper-x<=2.0 is available and srv-x==1.0 depends on helper-x>=3";
  for (const allowScripts of [false, true]) {
    const error = await resolvePython({
      stage: tmp(t),
      ref,
      python,
      index: "http://i/simple",
      cacheDir: tmp(t),
      allowScripts,
      constraints: ["helper-x<3"],
      execute: async () => {
        throw failure(conflict);
      },
      environment: {},
    }).catch((caught) => caught);
    assert.equal(error.code, "MCP_PACKAGE_UNSATISFIABLE");
    assert.equal(error.status, 400);
  }
});
```

`tests/unit/mcp-package-errors.test.js`: count `18`, plus

```js
test("a preview failure has its own wording without a log", () => {
  const error = packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502, "previewFailed");
  assert.equal(error.code, "MCP_PACKAGE_INSTALL_FAILED");
  assert.doesNotMatch(error.message, /Protokoll/);
  assert.equal(packageProblem("MCP_PACKAGE_UNSATISFIABLE", 400).status, 400);
});
```

`tests/unit/mcp-package-previews.test.js`: in "a rejected preview frees its resolve slot" also assert the message key:

```js
await assert.rejects(service.preview(source), (error) => {
  assert.equal(error.code, "MCP_PACKAGE_INSTALL_FAILED");
  assert.equal(error.message, serverMessages.mcpPackages.previewFailed);
  return true;
});
```

(import `serverMessages` from `../../server/lib/i18n/de.js`).

`tests/unit/mcp-package-labels.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { refusalField } from "../../web/features/mcp-servers/mcp-package-labels.js";

test("refusals belong to the field the owner can fix", () => {
  const key = (messageKey) => ({ messageKey });
  assert.equal(
    refusalField(key("mcpPackages.invalidConstraints"), "pypi"),
    "packageConstraints",
  );
  assert.equal(
    refusalField(key("mcpPackages.unsatisfiable"), "pypi"),
    "packageConstraints",
  );
  assert.equal(refusalField(key("mcpPackages.unsatisfiable"), "npm"), "packageVersion");
  assert.equal(refusalField(key("mcpPackages.versionYanked"), "pypi"), "packageVersion");
  assert.equal(refusalField(key("mcpPackages.previewFailed"), "pypi"), null);
  assert.equal(refusalField(null, "npm"), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/mcp-python-install.test.js tests/unit/mcp-package-errors.test.js tests/unit/mcp-package-previews.test.js tests/unit/mcp-package-labels.test.js`
Expected: FAIL.

- [ ] **Step 3: Codes and messages**

`package-errors.js` `keys`: `MCP_PACKAGE_UNSATISFIABLE: "unsatisfiable",`.

`server/lib/i18n/en/mcp-packages.js`:

```js
  unsatisfiable:
    "No set of dependency versions fits this package version and its constraints. Change the dependency constraints or choose another version.",
  previewFailed:
    "The package could not be resolved. Check the version, try again later or choose another version.",
```

`server/lib/i18n/de/mcp-packages.js`:

```js
  unsatisfiable:
    "Keine Kombination von Abhängigkeitsversionen passt zu dieser Paketversion und ihren Grenzen. Bitte die Abhängigkeitsgrenzen ändern oder eine andere Version wählen.",
  previewFailed:
    "Das Paket ließ sich nicht auflösen. Bitte die Version prüfen, später erneut versuchen oder eine andere Version wählen.",
```

- [ ] **Step 4: Classify the failures**

`python-package-install.js`:

```js
// uv's resolver report when no set of versions satisfies the requirements.
const noSolution = /No\s+solution\s+found\s+when\s+resolving/;
const unsatisfiable = () => packageProblem("MCP_PACKAGE_UNSATISFIABLE", 400);
/** What a failed `uv pip compile` means; a missing wheel wins (it needs a build). */
export function compileFailure(output) {
  if (noWheel.test(output)) return "build";
  if (noSolution.test(output)) return "unsatisfiable";
  return "failed";
}
const refusal = (output) =>
  compileFailure(output) === "unsatisfiable" ? unsatisfiable() : failed();
```

and in `resolvePython`:

```js
const trial = await compile(wheelsOnly);
let needsScripts = false;
if (!trial.ok) {
  if (compileFailure(trial.output) !== "build") throw refusal(trial.output);
  needsScripts = true;
  if (allowScripts !== true) return { requirementsText, lockText: null, needsScripts };
  const built = await compile([]);
  if (!built.ok) throw refusal(built.output);
}
```

`npm-package-install.js` `npm()` catch:

```js
const output = `${error.stdout || ""}\n${error.stderr || ""}`;
log?.(output);
if (signal?.aborted) throw packageProblem("MCP_PACKAGE_CANCELLED", 409);
// npm 11: "npm error code ETARGET" (no matching version) or ERESOLVE (peer conflict).
if (/\bcode (?:ETARGET|ERESOLVE)\b/.test(output))
  throw packageProblem("MCP_PACKAGE_UNSATISFIABLE", 400);
throw failed();
```

`mcp-packages.js` `preview()` catch:

```js
    } catch (error) {
      // A preview has no job log: a generic failure says so instead of "see the log".
      if (packageCode(error, "MCP_PACKAGE_INSTALL_FAILED") === "MCP_PACKAGE_INSTALL_FAILED")
        throw packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502, "previewFailed");
      throw error;
    }
```

(import `packageCode` from `./package-errors.js`).

- [ ] **Step 5: The refused field in the UI**

`web/features/mcp-servers/mcp-package-labels.js`:

```js
/** The form field a package refusal belongs to, else null (shown in the bar). */
export function refusalField(error, registry) {
  const key = error?.messageKey;
  if (key === "mcpPackages.invalidConstraints") return "packageConstraints";
  // Only PyPI has constraints; for npm another version is the fix.
  if (key === "mcpPackages.unsatisfiable")
    return registry === "pypi" ? "packageConstraints" : "packageVersion";
  if (key === "mcpPackages.versionYanked") return "packageVersion";
  return null;
}
```

`McpServerDetail.jsx`: delete `refusedConstraints`/`refusedVersion`, import `refusalField`, and replace the two `if` blocks in the outcome effect with

```js
const field = refusalField(failure, draft.values.registry);
if (field) {
  consumed.current = draft.outcome;
  setFieldError({ field, text: failure.message });
  return;
}
```

The effect keeps its `[draft.outcome]` dependencies: the registry is read when the refusal arrives, so add `// eslint-disable-next-line react-hooks/exhaustive-deps` above the dependency array (the pattern this file already uses for `initial`).

`McpPackagePanel.jsx` `act` catch:

```js
const field = refusalField(failure, source.registry);
if (field === "packageConstraints") setConstraintsError(failure.message);
else if (field === "packageVersion") setVersionError(failure.message);
else setError(failure.message);
```

- [ ] **Step 6: Docs**

`docs/mcp.md`, replace "A failed preview says only "installation failed" and shows no log." with:

```markdown
A preview that fails names the reason instead of a log: dependency limits that no
set of versions satisfies are reported at the constraints field (for npm at the
version), and any other failure asks you to check the version or try again later.
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/unit/mcp-python-install.test.js tests/unit/mcp-package-errors.test.js tests/unit/mcp-package-previews.test.js tests/unit/mcp-package-labels.test.js tests/unit/server-i18n-catalogs.test.js tests/integration/mcp-packages-routes.test.js && AGENTPIER_MCP_PYTHON_TESTS=1 node --test tests/integration/mcp-python-packages.test.js && npm run build && npx playwright test tests/browser/mcp-packages-pypi.spec.js --project=desktop`
Expected: PASS.

- [ ] **Step 8: Format and commit**

```bash
npx prettier --write server/features/mcp-packages server/lib/i18n web/features/mcp-servers tests/unit docs/mcp.md
git add server web tests docs/mcp.md
git commit -m "feat: name the reason when an MCP package preview fails

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The owner's CA for uv (owner decision 3)

**Decision (safest minimal approach):** AgentPier writes, per uv run, a private PEM bundle into the uv work folder made of **Node's bundled root certificates (`tls.rootCertificates`) plus every certificate in `NODE_EXTRA_CA_CERTS`**, and sets `SSL_CERT_FILE` to it. This is exactly the trust Node (and therefore npm and AgentPier's own downloads) uses, it works whether uv treats `SSL_CERT_FILE` as a replacement for or an addition to its bundled roots, it needs no new setting and no installer change, and it lives only for one run inside the stage. `UV_NATIVE_TLS` is **not** set: it would switch uv to the operating system's store, which differs from what Node trusts and on Linux depends on the distribution. Without `NODE_EXTRA_CA_CERTS`, or when the file is unusable (missing, not a file, over 1 MiB, no PEM block), uv keeps its own roots and AgentPier logs one line without the path. If the gated HTTPS test in Step 1 shows uv 0.12.21 ignores `SSL_CERT_FILE`, stop and report to the owner instead of switching to `UV_NATIVE_TLS`.

**Files:**

- Create: `server/features/mcp-packages/uv-certificates.js`
- Modify: `server/features/mcp-packages/python-package-install.js` (`uvEnvironment`)
- Modify: `tests/helpers/pypi-index-fixture.js` (optional TLS)
- Modify: `docs/installation.md`, `docs/mcp.md`
- Test: `tests/unit/mcp-uv-certificates.test.js`, `tests/unit/mcp-python-install.test.js`, `tests/integration/mcp-python-packages.test.js` (gated)

**Interfaces:**

- Produces: `uvCertificateFile(work, environment, { roots = tls.rootCertificates } = {}) → string | null`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mcp-uv-certificates.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { uvCertificateFile } from "../../server/features/mcp-packages/uv-certificates.js";

const pem = (body) => `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uv-ca-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the bundle is Node's roots plus the owner's CA, private to the run", (t) => {
  const dir = scratch(t);
  const extra = path.join(dir, "company.pem");
  fs.writeFileSync(extra, `junk\n${pem("COMPANY")}\n`);
  const file = uvCertificateFile(
    dir,
    { NODE_EXTRA_CA_CERTS: extra },
    { roots: [pem("ROOT")] },
  );
  assert.equal(path.dirname(file), dir);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, "utf8"), `${pem("ROOT")}\n${pem("COMPANY")}\n`);
});

test("without NODE_EXTRA_CA_CERTS uv keeps its own roots", (t) => {
  assert.equal(uvCertificateFile(scratch(t), {}), null);
});

test("an unusable extra CA file leaves uv on its own roots", (t) => {
  const dir = scratch(t);
  const errors = t.mock.method(console, "error", () => {});
  const big = path.join(dir, "big.pem");
  fs.writeFileSync(big, pem("x".repeat(1024 * 1024)));
  const empty = path.join(dir, "empty.pem");
  fs.writeFileSync(empty, "no certificates here");
  for (const value of [path.join(dir, "missing.pem"), dir, big, empty])
    assert.equal(uvCertificateFile(dir, { NODE_EXTRA_CA_CERTS: value }), null, value);
  const logged = errors.mock.calls.map((c) => String(c.arguments[0])).join("\n");
  assert.doesNotMatch(logged, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
```

`tests/unit/mcp-python-install.test.js`:

```js
test("uv gets SSL_CERT_FILE only when the owner configured a CA for Node", (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "uv-env-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const extra = path.join(work, "company.pem");
  fs.writeFileSync(extra, "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n");
  const base = { work, index: "https://pypi.org/simple", cacheDir: path.join(work, "c") };
  assert.equal(uvEnvironment({ ...base, environment: {} }).SSL_CERT_FILE, undefined);
  const env = uvEnvironment({ ...base, environment: { NODE_EXTRA_CA_CERTS: extra } });
  assert.match(
    fs.readFileSync(env.SSL_CERT_FILE, "utf8"),
    /-----BEGIN CERTIFICATE-----\nX\n/,
  );
  assert.equal(env.UV_NATIVE_TLS, undefined);
});
```

Gated end-to-end proof that uv honours the bundle: extend `pypiIndexFixture(t, python, packages, { tls } = {})` so that with `tls: { key, cert }` it uses `https.createServer({ key, cert }, handler)` and a `https://127.0.0.1:<port>` base (the handler is unchanged). Then append to `tests/integration/mcp-python-packages.test.js`:

```js
test(
  "uv trusts an index signed by the owner's CA through NODE_EXTRA_CA_CERTS",
  { skip },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uv-tls-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const key = path.join(dir, "key.pem");
    const cert = path.join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const python = await sharedPython();
    const index = await pypiIndexFixture(t, python, [server, helper], {
      tls: { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    });
    const stage = fs.mkdtempSync(path.join(dir, "stage-"));
    const resolve = (environment) =>
      resolvePython({
        stage,
        ref: { registry: "pypi", name: "srv-x", version: "1.0" },
        python,
        index: index.index,
        cacheDir: path.join(dir, "cache"),
        environment,
      });
    await assert.rejects(resolve({}), { code: "MCP_PACKAGE_INSTALL_FAILED" });
    const resolved = await resolve({ NODE_EXTRA_CA_CERTS: cert });
    assert.match(resolved.lockText, /^srv-x==1\.0 /m);
  },
);
```

(import `sharedPython` from the helper, `pypiIndexFixture` from `../helpers/pypi-index-fixture.js` and `resolvePython` from the server module.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/mcp-uv-certificates.test.js tests/unit/mcp-python-install.test.js`
Expected: FAIL — module missing; no `SSL_CERT_FILE`.

- [ ] **Step 3: Implement**

`server/features/mcp-packages/uv-certificates.js`:

```js
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

const limit = 1024 * 1024;
const certificate = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * The CA bundle uv trusts like Node does: Node's bundled roots plus the certificates
 * of NODE_EXTRA_CA_CERTS (a company CA behind a TLS-intercepting proxy), written into
 * the run's private `work` folder. Null when that variable is unset or its file is
 * unusable; uv then keeps its own roots (docs/installation.md).
 */
export function uvCertificateFile(
  work,
  environment = process.env,
  { roots = tls.rootCertificates } = {},
) {
  const extra = environment?.NODE_EXTRA_CA_CERTS;
  if (typeof extra !== "string" || !extra) return null;
  let found;
  try {
    const stat = fs.statSync(extra);
    if (!stat.isFile() || stat.size > limit) throw Error("unusable");
    found = fs.readFileSync(extra, "utf8").match(certificate) ?? [];
    if (!found.length) throw Error("no certificate");
  } catch {
    console.error(
      "AgentPier could not pass NODE_EXTRA_CA_CERTS to uv (unreadable or no certificate).",
    );
    return null;
  }
  const file = path.join(work, "ca-bundle.pem");
  fs.writeFileSync(file, `${[...roots, ...found].join("\n")}\n`, { mode: 0o600 });
  return file;
}
```

`python-package-install.js` `uvEnvironment` (it already creates `work/home` and `work/tmp`):

```js
export function uvEnvironment({ work, index, cacheDir, environment, allowScripts }) {
  for (const name of ["home", "tmp"]) privateFolder(path.join(work, name));
  const certificates = uvCertificateFile(work, environment ?? process.env);
  return {
    ...proxyEnvironment(environment),
    HOME: path.join(work, "home"),
    TMPDIR: path.join(work, "tmp"),
    PATH: ["/usr/bin", "/bin"].join(path.delimiter),
    NO_COLOR: "1",
    UV_NO_CONFIG: "1",
    UV_INDEX_URL: index,
    UV_PYTHON_DOWNLOADS: "never",
    UV_LINK_MODE: "copy",
    UV_CACHE_DIR: privateFolder(cacheDir),
    // Node's roots plus the owner's CA, as one file: see uv-certificates.js.
    ...(certificates ? { SSL_CERT_FILE: certificates } : {}),
    ...(allowScripts === true ? { CC: "cc", CXX: "c++" } : {}),
  };
}
```

Update the comment above `uvEnvironment` ("Only proxy variables and the owner's CA (as SSL_CERT_FILE) are passed on; …"). The work folder is removed after every run, so the bundle never outlives it. Also update the comment in `server/lib/proxy-environment.js` ("npm ci, the assistant Gateway, its own service") to mention that uv receives the CA as a bundle (uv-certificates.js).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/mcp-uv-certificates.test.js tests/unit/mcp-python-install.test.js && AGENTPIER_MCP_PYTHON_TESTS=1 node --test tests/integration/mcp-python-packages.test.js`
Expected: PASS. If only the gated "with CA" case fails, uv ignores `SSL_CERT_FILE`: stop and report (see Decision).

- [ ] **Step 5: Docs**

`docs/installation.md`, replace the sentence "`uv` (used for PyPI MCP packages) does not read `NODE_EXTRA_CA_CERTS`, so behind a TLS-intercepting proxy PyPI previews and installs fail until a follow-up passes the CA to `uv`:" with

```markdown
`uv` (used for PyPI MCP packages) does not read `NODE_EXTRA_CA_CERTS` itself; for
each uv run AgentPier writes a private bundle of Node's built-in root certificates
plus the certificates in that file and passes it as `SSL_CERT_FILE`, so PyPI
previews and installs trust the same CA as npm. An unreadable file (or one without
a PEM certificate) is skipped with a log line, and uv then uses its own roots:
```

and in the bullet "AgentPier passes the same set to `npm ci` and to the assistant Gateway." append " and, as the bundle above, to `uv`."

`docs/mcp.md`: after "Only `registry.npmjs.org` (npm) and `pypi.org` … are accepted anywhere in the graph." add "Behind a TLS-intercepting proxy, uv trusts the CA set in `NODE_EXTRA_CA_CERTS` (see [Installation](installation.md))."

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write server/features/mcp-packages/uv-certificates.js server/features/mcp-packages/python-package-install.js server/lib/proxy-environment.js tests/unit/mcp-uv-certificates.test.js tests/unit/mcp-python-install.test.js tests/integration/mcp-python-packages.test.js tests/helpers/pypi-index-fixture.js docs/installation.md docs/mcp.md
git add server tests docs
git commit -m "feat: pass the owner's CA to uv as a bundle with Node's roots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Audit lengths for package references

**Files:**

- Modify: `server/features/audit/audit-schema.js`
- Test: `tests/unit/audit-schema.test.js`

- [ ] **Step 1: Write the failing test**

Append inside or after "MCP package audits keep registry, name, version, allowScripts and constraints":

```js
test("MCP package audits keep the longest constraint and version the service accepts", () => {
  const packageEvent = (details) =>
    auditEvent({
      action: "package.installed",
      resourceType: "mcp",
      resourceId: "s1",
      source: "user",
      outcome: "success",
      details,
    });
  // 100 characters: the constraint limit of package-spec.js.
  const line = `helper-x>=${"1.".repeat(43)}1,<2`;
  assert.equal(line.length, 100);
  const npmVersion = `1.0.0-${"a".repeat(200)}`;
  assert.deepEqual(
    packageEvent({ registry: "pypi", name: "srv", version: "1.0", constraints: [line] })
      .details.constraints,
    [line],
  );
  assert.equal(
    packageEvent({ registry: "npm", name: "srv", version: npmVersion }).details.version,
    npmVersion,
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/audit-schema.test.js`
Expected: FAIL — the 100-character constraint (specifier version > 40 characters) and the 206-character npm version are dropped.

- [ ] **Step 3: Align the limits with package-spec.js**

```js
// The limits of package-spec.js: npm versions up to 256 characters, a constraint
// line up to 100 (one specifier may use nearly all of it).
const packageVersion = /^[0-9][0-9A-Za-z.+!-]{0,255}$/;
const specifier = String.raw`(?:==|!=|~=|<=|>=|<|>)[0-9][0-9a-z.*!]{0,97}`;
```

(The `line.length <= 100` filter in `packageDetails` keeps the overall bound.)

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/unit/audit-schema.test.js tests/property/audit.test.js`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write server/features/audit/audit-schema.js tests/unit/audit-schema.test.js
git add server/features/audit/audit-schema.js tests/unit/audit-schema.test.js
git commit -m "fix: audit package constraints and versions up to their accepted length

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Package UI polish

**Files:**

- Modify: `web/features/mcp-servers/mcp-package-labels.js` (`showsPath`)
- Modify: `web/features/mcp-servers/McpPackageConfirmation.jsx`, `McpPackageFields.jsx`, `McpPackagePanel.jsx`, `McpServerFields.jsx`, `mcp-server-draft.js`
- Modify: `web/lib/i18n/de/mcp-packages.js`, `web/lib/i18n/en/mcp-packages.js`
- Modify: `web/features/accounts/accounts.css`, `web/features/mcp-servers/mcp-servers.css`
- Test: `tests/unit/mcp-package-labels.test.js`, `tests/unit/mcp-server-draft.test.js`, `tests/browser/mcp-packages.spec.js`

**Interfaces:**

- Produces: `showsPath(entry, list) → boolean`; `keepPackageValues(server) → { source, command, args }` in `mcp-server-draft.js`; copy keys `dependencyAt(label, path)`, `namePlaceholder.{npm,pypi}`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mcp-package-labels.test.js` (add `showsPath` to the import):

```js
test("only nested copies of one name show their lock path", () => {
  const list = [
    { name: "extra", version: "2.0.0", path: "extra" },
    { name: "extra", version: "2.0.0", path: "helper > extra" },
    { name: "helper", version: "1.0.0", path: "helper" },
  ];
  assert.equal(showsPath(list[0], list), false);
  assert.equal(showsPath(list[1], list), true);
  assert.equal(showsPath(list[2], list), false);
  assert.equal(
    showsPath({ name: "x", version: "1" }, [{ name: "x" }, { name: "x" }]),
    false,
  );
});
```

`tests/unit/mcp-server-draft.test.js` (add `keepPackageValues` to the import):

```js
test("keeping the package restores the stored command and owner args", () => {
  const server = {
    transport: "stdio",
    command: "/data/node",
    args: ["/data/installs/i/x.js", "--owner"],
    source: { registry: "npm", leadingArgs: 1 },
  };
  assert.deepEqual(keepPackageValues(server), {
    source: "package",
    command: "",
    args: "--owner",
  });
});
```

`tests/browser/mcp-packages.spec.js` — update "an update shows the lock diff before it is confirmed": replace

```js
await expect(confirm.getByText("extra 2.0.0")).toHaveCount(2);
```

with

```js
await expect(confirm.getByText("extra 2.0.0", { exact: true })).toHaveCount(1);
await expect(confirm.getByText("extra 2.0.0 (helper > extra)")).toBeVisible();
```

and after `await confirm.getByRole("button", { name: "Update" }).click();` nothing else changes. Add new tests:

```js
test("cancelling the update confirmation returns focus to Check update", async ({
  page,
}) => {
  const state = await packageSetup(page, { servers: [packagedServer("ready")] });
  state.preview = preview({ diff: { added: [], removed: [], changed: [] } });
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  const panel = dialog.getByRole("region", { name: "Package" });
  await panel.getByRole("button", { name: "Check update" }).click();
  await panel
    .getByRole("alertdialog", { name: "Update this package?" })
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(panel.getByRole("button", { name: "Check update" })).toBeFocused();
});

test("keeping the package after typing a command leaves nothing to save", async ({
  page,
}) => {
  await packageSetup(page, { servers: [packagedServer("ready")] });
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  await dialog.getByRole("button", { name: "Use own command" }).click();
  await dialog.getByRole("textbox", { name: /^Command/ }).fill("/usr/bin/server-x");
  await dialog.getByLabel("Arguments").fill("--other");
  await dialog.getByRole("button", { name: "Keep package" }).click();
  await expect(saveBar(page)).toHaveCount(0);
  await expect(dialog.getByLabel("Arguments")).toHaveValue("--owner");
});

test("a new package name clears the chosen version until its list loads", async ({
  page,
}) => {
  const state = await packageSetup(page);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route(/\/api\/mcp-packages\/versions\?.*name=other/, async (route) => {
    await held;
    await route.fulfill({ json: state.versions });
  });
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await choosePackage(dialog);
  await dialog.getByLabel("Package", { exact: true }).fill("server-x");
  const version = dialog.getByLabel("Version", { exact: true });
  await expect(version).toHaveValue("1.1.0");
  await dialog.getByLabel("Package", { exact: true }).fill("other");
  await expect(version).toHaveValue("");
  release();
  await expect(version).toHaveValue("1.1.0");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/mcp-package-labels.test.js tests/unit/mcp-server-draft.test.js && npm run build && npx playwright test tests/browser/mcp-packages.spec.js --project=desktop`
Expected: FAIL.

- [ ] **Step 3: Catalogs (de + en)**

en:

```js
  dependencyAt: (label, path) => `${label} (${path})`,
  namePlaceholder: { npm: "@scope/server", pypi: "mcp-server-name" },
```

de:

```js
  dependencyAt: (label, path) => `${label} (${path})`,
  namePlaceholder: { npm: "@scope/server", pypi: "mcp-server-name" },
```

- [ ] **Step 4: Implement**

`mcp-package-labels.js`:

```js
/** A nested copy of a name that appears more than once shows where it sits in the graph. */
export const showsPath = (entry, list) =>
  typeof entry.path === "string" &&
  entry.path !== entry.name &&
  list.filter((other) => other.name === entry.name).length > 1;
```

`McpPackageConfirmation.jsx`: import `showsPath`; add

```js
const labelled = (entry, list, text) =>
  showsPath(entry, list) ? copy.dependencyAt(text, entry.path) : text;
```

in `LockDiff` render `{labelled(entry, list, text(entry))}`; in the dependency list `{labelled(entry, preview.dependencies || [], `${entry.name} ${entry.version}`)}`.

`McpPackageFields.jsx`: placeholder `placeholder={copy.namePlaceholder[values.registry] ?? copy.namePlaceholder.npm}`; name change clears the version:

```jsx
          onChange={(event) => {
            set("packageName")(event.target.value);
            // A version belongs to one package; the new list preselects again.
            set("packageVersion")("");
          }}
```

`McpPackagePanel.jsx`: the Check update button gets `data-focus-key={`mcp-package-check-${server.id}`}` and the confirmation `returnKey={`mcp-package-check-${server.id}`}`.

`mcp-server-draft.js`:

```js
/** The fields "Keep package" restores: the package source and the stored owner args. */
export function keepPackageValues(server) {
  const stored = draftFrom(server);
  return { source: "package", command: stored.command, args: stored.args };
}
```

`McpServerFields.jsx` `McpSourceField` onClick:

```jsx
          onClick={() => {
            if (!detaching) return set("source")("command");
            // Keep package: back to exactly what is stored, so nothing is left to save.
            for (const [key, value] of Object.entries(keepPackageValues(server)))
              set(key)(value);
          }}
```

CSS: `web/features/accounts/accounts.css:56` and `web/features/mcp-servers/mcp-servers.css:195` → `color: var(--error-text);`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/unit/mcp-package-labels.test.js tests/unit/mcp-server-draft.test.js tests/unit/i18n-catalogs.test.js && grep -rn "f0b9ab" web; npm run build && npx playwright test tests/browser/mcp-packages.spec.js tests/browser/mcp-packages-pypi.spec.js --project=desktop`
Expected: PASS; grep prints nothing.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write web/features/mcp-servers web/lib/i18n/de/mcp-packages.js web/lib/i18n/en/mcp-packages.js web/features/accounts/accounts.css tests/unit/mcp-package-labels.test.js tests/unit/mcp-server-draft.test.js tests/browser/mcp-packages.spec.js
git add web tests
git commit -m "fix: polish the MCP package form, confirmation and panel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Remaining test gaps and the frozen manifest

**Files:**

- Modify: `server/features/mcp-packages/toolchain-manifest.js` (deep freeze)
- Modify: `tests/helpers/mcp-python-service.js` (setuptools retry)
- Test: `tests/unit/mcp-package-compile.test.js`, `tests/unit/mcp-toolchain-prune.test.js`, `tests/integration/mcp-packages-routes.test.js`, `tests/unit/mcp-toolchains.test.js`, `tests/unit/mcp-package-errors.test.js`, `tests/unit/mcp-verified-files.test.js`, `tests/unit/mcp-toolchain-manifest.test.js`

- [ ] **Step 1: Write the tests**

`tests/unit/mcp-package-compile.test.js`:

```js
test("OpenClaw skips a server whose command is null, packaged or not", () => {
  const secrets = { headers: {}, env: {} };
  assert.equal(mcpServerConfig({ ...packaged("ready"), command: null }, secrets), null);
  const plain = { ...packaged("ready"), command: null };
  delete plain.packageStatus;
  delete plain.managedDirs;
  assert.equal(mcpServerConfig(plain, secrets), null);
  assert.equal(mcpServerConfig(packaged("choosing"), secrets), null);
});
```

`tests/unit/mcp-toolchain-prune.test.js`:

```js
test("an unresolvable in-use entry (null) disables pruning", async (t) => {
  const { f, root, opts } = await installed(t);
  const before = listed(root);
  assert.deepEqual(await pruneToolchains(f.dataDir, [null], opts), []);
  assert.deepEqual(listed(root), before);
});
```

`tests/integration/mcp-packages-routes.test.js`:

```js
test("a source that is not an object, or null on an own-command server, is invalid", async (t) => {
  const s = await packageService(t);
  const { request } = await app(t, {
    mcpServerChanges: s.changes,
    mcpServers: s.servers,
    mcpPackages: s.packages,
  });
  const own = await s.changes.create(
    { name: "own", transport: "stdio", command: s.executable("own") },
    { confirmStdio: true },
  );
  for (const bad of ["x", 7, [], true]) {
    const created = await request("POST", "/api/mcp-servers", {
      name: "pkg",
      transport: "stdio",
      source: bad,
      confirmInstall: true,
    });
    assert.equal(created.status, 400, JSON.stringify(bad));
    assert.equal(created.body.code, "MCP_PACKAGE_INVALID");
    const changed = await request("PUT", `/api/mcp-servers/${own.id}`, {
      revision: own.revision,
      source: bad,
      confirmInstall: true,
    });
    assert.equal(changed.status, 400, JSON.stringify(bad));
    assert.equal(changed.body.code, "MCP_PACKAGE_INVALID");
  }
  // `source: null` detaches a packaged server only; an own-command server has none.
  const detached = await request("PUT", `/api/mcp-servers/${own.id}`, {
    revision: own.revision,
    source: null,
    command: "/bin/x",
  });
  assert.equal(detached.status, 400);
  assert.equal(detached.body.code, "MCP_PACKAGE_INVALID");
  assert.equal(s.servers.list().length, 1);
});

test("an attach without other edits stores nothing but the package", async (t) => {
  const attached = [];
  const { request, updates } = await app(t, {
    mcpPackages: {
      isPackaged: () => false,
      attach: async (id, input, beforeInstall) => {
        attached.push({ id, input, beforeInstall });
        return packagedServer;
      },
    },
  });
  // A stale revision: the attach itself writes only the package record; the later
  // command switch re-reads the current revision (package-install-job.js).
  const response = await request("PUT", "/api/mcp-servers/s1", {
    revision: 1,
    source,
    previewId: "p",
    confirmInstall: true,
  });
  assert.equal(response.status, 202);
  assert.equal(attached[0].beforeInstall, undefined);
  assert.equal(updates.length, 0);
});
```

(The real service refuses these in `createServer` and `changeSource` already; the test pins it. `s.executable(name)` is the fixture's own-command helper, as in "an own-command server switches to a package and back (D1)".)

`tests/unit/mcp-toolchains.test.js`:

```js
test("a toolchain is refused for an unsupported architecture or a musl Linux", async (t) => {
  const f = toolchainFixture(t);
  for (const host of [
    { platform: "linux", arch: "ppc64", glibc: "2.39" },
    { platform: "darwin", arch: "ia32" },
    { platform: "linux", arch: "arm64", glibc: null },
  ])
    for (const kind of ["node", "python"])
      await assert.rejects(
        ensureToolchain(kind, {
          dataDir: f.dataDir,
          download: f.download,
          manifest: f.manifest,
          ...host,
        }),
        { code: "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE" },
        `${kind} ${JSON.stringify(host)}`,
      );
  assert.deepEqual(f.downloads, []);
});

test("the glibc option is what pruning uses on Linux", async (t) => {
  const f = toolchainFixture(t);
  await assert.rejects(
    pruneToolchains(f.dataDir, [], { platform: "linux", arch: "x64", glibc: null }),
    { code: "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE" },
  );
  assert.deepEqual(
    await pruneToolchains(f.dataDir, [], {
      platform: "linux",
      arch: "x64",
      glibc: "2.39",
    }),
    [],
  );
});
```

`tests/unit/mcp-package-errors.test.js`:

```js
test("packageCode keeps known codes only", () => {
  assert.equal(packageCode(null, "F"), "F");
  assert.equal(packageCode(undefined, "F"), "F");
  assert.equal(packageCode({ code: "toString" }, "F"), "F");
  assert.equal(packageCode({ code: "EACCES" }, "F"), "F");
  assert.equal(packageCode({ code: "MCP_PACKAGE_BUSY" }, "F"), "MCP_PACKAGE_BUSY");
  assert.equal(packageCode("MCP_PACKAGE_BUSY", "F"), "F");
});
```

`tests/unit/mcp-verified-files.test.js`:

```js
test("regularFile refuses folders and missing files with the given code", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verified-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => regularFile(dir, "MCP_PACKAGE_INSTALL_FAILED"), {
    code: "MCP_PACKAGE_INSTALL_FAILED",
  });
  assert.throws(() => regularFile(path.join(dir, "missing")), {
    code: "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE",
  });
  assert.equal(sha256Matches(Buffer.from("abc"), ""), false);
  assert.equal(sha256Matches(Buffer.from("abc"), undefined), false);
});
```

`tests/unit/mcp-toolchain-manifest.test.js`:

```js
test("the manifest is frozen all the way down and shares nothing mutable", () => {
  for (const part of [
    toolchainManifest.node,
    toolchainManifest.node.checksums,
    toolchainManifest.uv,
    toolchainManifest.uv.checksums,
    toolchainManifest.uv.triples,
    toolchainManifest.python,
    toolchainManifest.python.checksums,
  ])
    assert.equal(Object.isFrozen(part), true);
  assert.notEqual(toolchainManifest.node.checksums, runtimeManifest.nodeChecksums);
});
```

(import `runtimeManifest` from `../../server/features/assistants/runtime-manifest.js`.)

- [ ] **Step 2: Run them**

Run: `node --test tests/unit/mcp-package-compile.test.js tests/unit/mcp-toolchain-prune.test.js tests/integration/mcp-packages-routes.test.js tests/unit/mcp-toolchains.test.js tests/unit/mcp-package-errors.test.js tests/unit/mcp-verified-files.test.js tests/unit/mcp-toolchain-manifest.test.js`
Expected: only the manifest test FAILS (the others pin existing behaviour; if one fails, that is a real bug — fix it in this task and say so in the commit body).

- [ ] **Step 3: Freeze the manifest deeply**

`server/features/mcp-packages/toolchain-manifest.js`:

```js
const triples = Object.freeze({ ...unchanged entries... });
```

```js
export const toolchainManifest = Object.freeze({
  node: Object.freeze({
    version: runtimeManifest.nodeVersion,
    npmVersion: runtimeManifest.npmVersion,
    // A frozen copy: the runtime manifest's object stays its own.
    checksums: Object.freeze({ ...runtimeManifest.nodeChecksums }),
    url: (target) => `...unchanged...`,
  }),
  uv: Object.freeze({
    version: uvVersion,
    triples,
    checksums: Object.freeze({ ...unchanged... }),
    url: (target) => `...unchanged...`,
  }),
  python: Object.freeze({
    version: pythonVersion,
    build: pythonBuild,
    checksums: Object.freeze({ ...unchanged... }),
    asset: pythonAsset,
    url: (target) => `...unchanged...`,
  }),
});
```

- [ ] **Step 4: Retry the pinned setuptools download**

`tests/helpers/mcp-python-service.js`, in `pinnedSetuptools()` replace the single fetch with:

```js
let bytes;
for (let attempt = 0; ; attempt++) {
  try {
    const response = await fetch(setuptools.url);
    if (!response.ok) throw Error(`setuptools download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    break;
  } catch (error) {
    // files.pythonhosted.org hiccups must not fail the gated build tests.
    if (attempt >= 2) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}
if (!ok(bytes)) throw Error("setuptools checksum mismatch");
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/unit/mcp-toolchain-manifest.test.js tests/unit/mcp-toolchains.test.js tests/unit/mcp-toolchain-provisioning.test.js && AGENTPIER_MCP_PYTHON_TESTS=1 node --test tests/integration/mcp-python-packages.test.js`
Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write server/features/mcp-packages/toolchain-manifest.js tests
git add server/features/mcp-packages/toolchain-manifest.js tests
git commit -m "test: cover MCP package edge cases and freeze the toolchain manifest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Docs review, full verification and plan cleanup

**Files:**

- Review: `docs/mcp.md`, `docs/installation.md`, `docs/mcp-package-qualification.md`, `README.md`, `README.de.md`
- Delete: `docs/superpowers/plans/2026-10-15-mcp-packages-hardening.md`

- [ ] **Step 1: Docs review**

Run: `grep -n -i "program required\|see the log\|Installing…\|NODE_EXTRA_CA_CERTS\|choose program\|cancel" docs/mcp.md docs/installation.md docs/mcp-package-qualification.md README.md README.de.md`

Check every hit against the new behaviour: the status list names _Choose program_; deleting during an install stops npm/uv; a failed preview names a reason; uv gets the CA bundle; the audit list names `package.activated`. `docs/mcp-package-qualification.md` records qualified servers and their observed behaviour — change it only if a recorded behaviour changed (none is expected: its servers have a single program, and none was qualified behind a TLS proxy); note "checked, unchanged" in the PR description.

- [ ] **Step 2: Full verification**

Run: `npm run check`
Expected: lint, formatting, structure (no file over 600 lines), build and all Node suites PASS.

Run: `AGENTPIER_MCP_PYTHON_TESTS=1 node --test tests/integration/mcp-python-packages.test.js tests/unit/mcp-wheel-zip.test.js`
Expected: PASS.

Run: `npx playwright test tests/browser/mcp-packages.spec.js tests/browser/mcp-packages-pypi.spec.js`
Expected: PASS on every configured project.

- [ ] **Step 3: Delete the plan and commit**

```bash
git rm docs/superpowers/plans/2026-10-15-mcp-packages-hardening.md
git commit -m "chore: remove the completed MCP package hardening plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The pull request description (English) lists: the problem per ticket area, the three owner decisions and how they behave, validation (the commands above, gated uv runs), the docs checked/updated (`docs/mcp.md`, `docs/installation.md`, `docs/mcp-package-qualification.md` unchanged, READMEs unchanged), screenshots of the _Choose program_ panel (English and German) via the assets repository, and "Closes AGENTPIER-77, AGENTPIER-79 (except the audit-action guard test, done in AGENTPIER-78)".
