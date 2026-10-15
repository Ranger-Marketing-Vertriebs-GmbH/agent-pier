# MCP Packages 3/3: PyPI Packages and Qualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can install a stdio MCP server from a PyPI package at an exact version, wheels only by default and source builds only with the per-package opt-in, optionally narrowing its dependencies with owner-entered constraints, and the feature is qualified with real npm and PyPI servers, including a read-only OPNsense server bound to the network architect agent.

**Architecture:** The npm-specific code of plan 2 (in `McpPackages.resolvePreview`, `McpPackages.reinstall`, `checkLock` and `runInstall` in `package-install-job.js`) moves behind a registry adapter (`npm-adapter.js`); `python-adapter.js` implements the same interface with uv: a trial `uv pip compile --only-binary :all:` detects packages that need a build, `uv pip compile --generate-hashes --no-header --no-annotate` (plus `-c constraints.txt` when the owner entered dependency constraints) freezes the graph, `uv venv --relocatable` plus `uv pip sync --require-hashes` installs it, programs come from the top wheel's `entry_points.txt`, and the command is `<install>/venv/bin/<program>`. Records, jobs, routes, UI, compilers, grants and backups stay shared.

**Tech Stack:** Node.js ES modules, managed uv 0.12.21 and CPython 3.14.7 (plan 1), `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-mcp-package-install-design.md` (PyPI parts, "Manual qualification", "Resolved questions" 2 and 4). Preflight evidence: `.superpowers/sdd/2026-10-14-mcp-packages-3-pypi/preflight.md`.

## Global Constraints

- Plans 1 and 2 are merged (`origin/main` 75c85304). Interfaces are used as the code defines them, not as plan 2 described them: `ensureToolchain("python", { dataDir })` → `{ kind: "python", directory, uvPath, uvVersion, pythonVersion, pythonPath }` (no `version` field); `packageProblem(code, status, messageKey?)`, `packageCode`, `packageError`; `stageInstall`, `commitInstall`, `readInstall`, `pruneInstalls`, `installDirectory`, `packageRoot`; `PackageRecords` (columns `program`, `program_path` are NOT NULL); `PackageJobs`; `lockDiff` (keys `name` + `path`), `lockDigest`; `chooseProgram`; `runInstall`, `sourceFields`, `activate` in `package-install-job.js`.
- `pythonPath` is `<toolchain>/cpython/bin/python3` and is always passed explicitly (`--python`). CPython is an extracted python-build-standalone archive; PR 1 relocated only `_sysconfigdata_*.py`. Not relocated: `_sysconfig_vars_*.json`, pkgconfig, `python3.x-config`, the libpython install name, and `CC = clang` (preflight B11). Moving the data directory later leaves sysconfig pointing at the old path (documented, not fixed here).
- Index: only `https://pypi.org/simple` (files from `https://files.pythonhosted.org`); tests inject a local index.
- uv environment for every call (built from scratch, nothing else inherited): `UV_NO_CONFIG=1`, `UV_INDEX_URL=<index>`, `UV_PYTHON_DOWNLOADS=never`, `UV_LINK_MODE=copy`, `UV_CACHE_DIR=<data>/mcp-packages/.uv-cache`, `NO_COLOR=1`, private `HOME`/`TMPDIR`, `PATH=/usr/bin:/bin`, plus `proxyEnvironment(environment)`. With the opt-in only: `CC=cc`, `CXX=c++` (uv patches its own managed Pythons the same way; without it a Linux host without clang cannot build any C extension, preflight B12).
- Compile always passes `--generate-hashes --no-header --no-annotate --python <pythonPath>`: the header stores the `--python` path and the `# via` annotations name the input and constraints files by path (preflight B2), which would put stage paths into the stored lock.
- Without opt-in: `--only-binary :all:` on compile and sync. With opt-in: no such flag. Build dependencies of an sdist (for example `setuptools`) come from the index at build time and are not in the hashed lock (preflight B13); a compile with the opt-in may run an sdist's build backend to read its metadata, so package code can already run at preview time (B14). Both are stated in the docs and the opt-in warning.
- needsScripts detection (spec "Resolved questions" 4): the trial `uv pip compile --only-binary :all:` fails with `has no usable wheels` / `Wheels are required for` (verified with uv 0.12.21 and `docopt==0.6.2`, preflight B4). Any other trial failure (for example `requires_python` excluding 3.14) is `MCP_PACKAGE_INSTALL_FAILED`.
- Owner decision D3: lock lines with environment markers (`name==1.0 ; python_version >= "3.11"`) are allowed; extras (`name[extra]==1.0`) are rejected as `MCP_PACKAGE_FOREIGN_SOURCE`.
- Owner decision D4 (2026-10-15): a PyPI source may carry up to 10 dependency constraint lines (PEP 508 name plus version specifiers only, for example `fastmcp<4`). They are validated strictly, passed to the resolve as a uv constraints file, stored in the package record (column `constraints`, kept in backups), shown in preview, confirmation and status, frozen into the hashed lock (reinstall never resolves again) and kept by an update unless edited. npm sources take none.
- Owner decision D5 (2026-10-15): build tools that an sdist build fetches at build time stay outside the hashed lock; this happens only with the explicit build opt-in, and the confirmation's scripts/builds warning names it (de+en).
- Preview resolves are capped at 2 at a time per service (`previewConcurrency`); a third concurrent preview is `409 MCP_PACKAGE_BUSY` with the message key `previewBusy`.
- Copy in German and English with matching keys (`web/lib/i18n/{de,en}/mcp-packages.js`, `server/lib/i18n/{de,en}/mcp-packages.js`); source and test files ≤ 600 lines; commits in English with the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer; never push to `main`.

## Review Focus

1. **A requirements lock with a direct URL, VCS, editable, option or extras line** (`pkg @ https://…`, `git+`, `-e`, `--extra-index-url`, `pkg[extra]==1`): refused with `MCP_PACKAGE_FOREIGN_SOURCE` before any sync; a marker line is accepted (Task 2).
2. **A PyPI release whose top package exists only as sdist and the owner did not opt in:** preview reports `needsScripts: true` and creation is refused with `MCP_PACKAGE_NEEDS_SCRIPTS`, not `MCP_PACKAGE_NO_PROGRAM`; nothing is built (Tasks 4 and 6).
3. **Console scripts of dependencies** (the venv's `bin/` also holds `mcp`, `uvicorn`, `httpx`): only the top distribution's `console_scripts` are offered, and the chosen one is checked again after install (Tasks 3 and 6).
4. **A yanked version selected deliberately:** installable, marked in the dropdown (Tasks 1 and 9).
5. **The install directory moved by the stage rename:** the program still starts (relocatable venv), the receipt check passes, and no file of the install is a hard link into `.uv-cache` (Task 6).
6. **The npm path after the adapter extraction:** every plan 2 test passes unchanged except the explicit `yanked: false` addition (Task 4).
7. **A source build on Linux without clang:** `CC=cc` makes a real setuptools C extension build (Task 7).
8. **Dependency constraints (D4):** only `name` + version specifiers pass validation (no URL, path, extra, marker, option); they change the resolve but never a reinstall; an update keeps them unless edited; an npm source with constraints is refused (Task 8).

---

## File Structure

| File                                                                                                                                                                                             | Responsibility                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Modify `server/features/mcp-packages/package-spec.js`                                                                                                                                            | `registries` gains `pypi`; PEP 503 names; exact PEP 440 versions; `canonicalPypiVersion`.            |
| Modify `server/features/mcp-packages/registry-metadata.js`                                                                                                                                       | PyPI JSON → versions (with `yanked`), version files; npm versions gain `yanked: false`.              |
| Create `server/features/mcp-packages/python-lock-check.js`                                                                                                                                       | Parse and validate `requirements.lock` (D3); dependency list.                                        |
| Create `server/features/mcp-packages/wheel-programs.js`                                                                                                                                          | Console scripts from a wheel or an installed `.dist-info`.                                           |
| Modify `server/features/mcp-packages/package-store.js`                                                                                                                                           | `pythonCommand`.                                                                                     |
| Create `server/features/mcp-packages/npm-adapter.js`                                                                                                                                             | Plan 2's npm calls behind the adapter interface.                                                     |
| Modify `server/features/mcp-packages/mcp-packages.js`, `package-install-job.js`                                                                                                                  | Adapters by `ref.registry`, `cacheDir(registry)`, `checkStored`, preview cap, program after install. |
| Create `server/features/mcp-packages/python-package-install.js`                                                                                                                                  | uv environment, trial and real compile, venv, sync.                                                  |
| Create `server/features/mcp-packages/python-adapter.js`                                                                                                                                          | PyPI adapter.                                                                                        |
| Modify `server/lib/i18n/{de,en}/mcp-packages.js`                                                                                                                                                 | `previewBusy`, `invalidConstraints`.                                                                 |
| Modify `server/features/mcp-packages/package-records.js`, `server/features/operations/mcp-server-backup.js`, `server/http/routes/mcp-packages.js`                                                | Constraints column (with migration), backup column list, audit details.                              |
| Modify `web/lib/i18n/{de,en}/mcp-packages.js`, `web/features/mcp-servers/McpPackageFields.jsx`, `McpPackageConfirmation.jsx`, `McpPackagePanel.jsx`, `mcp-server-draft.js`, `mcp-server-save.js` | PyPI option, `yanked`, constraints field, program after build, opt-in and build-tools wording.       |
| Create `tests/helpers/pypi-index-fixture.js`, `tests/helpers/mcp-python-service.js`                                                                                                              | Local PEP 503 index + JSON API; Python service on `cliMcpFixture`.                                   |
| Modify `.github/workflows/mcp-toolchains.yml`, `tests/unit/mcp-toolchains-workflow.test.js`                                                                                                      | Python install tests in the native Linux/macOS job.                                                  |
| Create `docs/mcp-package-qualification.md`; modify `docs/mcp.md`, `docs/AGENTS.md`                                                                                                               | Results and behaviour.                                                                               |

---

### Task 1: PyPI references and metadata

**Files:**

- Modify: `server/features/mcp-packages/package-spec.js`, `server/features/mcp-packages/registry-metadata.js`
- Test: extend `tests/unit/mcp-package-spec.test.js`, `tests/unit/mcp-registry-metadata.test.js`

**Interfaces:**

- Produces: `registries` = `["npm", "pypi"]`; `normalizePypiName(name)` → PEP 503 form; `pypiVersionPattern`; `canonicalPypiVersion(version)` (lowercase, no leading zeros in numeric parts: `2026.01.10` → `2026.1.10`); `pypiRegistry = "https://pypi.org"`; `pypiProject(name, { registry, download })` → JSON of `<registry>/pypi/<name>/json`; `pypiVersions(project)` → `{ latest, versions: [{ version, publishedAt, prerelease, deprecated: false, yanked }] }` (releases without files and keys that are not exact PEP 440 versions are left out, so the dropdown never offers a version `packageRef` refuses); `pypiVersionInfo(project, version)` → `{ files: [{ filename, url, sha256, packagetype }], requiresPython }`. npm versions gain `yanked: false`.

- [ ] **Step 1: Write the failing tests**

```js
// add to tests/unit/mcp-package-spec.test.js
import { canonicalPypiVersion } from "../../server/features/mcp-packages/package-spec.js";

test("PyPI references are normalised and need an exact PEP 440 version", () => {
  assert.deepEqual(
    packageRef({ registry: "pypi", name: "MCP_Server.Time", version: "2026.10.10" }),
    { registry: "pypi", name: "mcp-server-time", version: "2026.10.10" },
  );
  assert.equal(
    packageRef({ registry: "pypi", name: "x", version: "1.0rc1" }).version,
    "1.0rc1",
  );
  for (const version of [
    "~=1.0",
    ">=1",
    "1.*",
    "1.0 ; python_version<'3'",
    "latest",
    "1.0+local",
  ])
    assert.throws(
      () => packageRef({ registry: "pypi", name: "x", version }),
      { code: "MCP_PACKAGE_INVALID" },
      version,
    );
  for (const name of ["-x", "x-", "a b", "x@https://e", "../x", "x[cli]"])
    assert.throws(
      () => packageRef({ registry: "pypi", name, version: "1.0" }),
      { code: "MCP_PACKAGE_INVALID" },
      name,
    );
  assert.equal(canonicalPypiVersion("2026.01.10"), "2026.1.10");
  assert.equal(canonicalPypiVersion("1.0RC01"), "1.0rc1");
  assert.equal(canonicalPypiVersion("0.4.1"), "0.4.1");
});
```

```js
// add to tests/unit/mcp-registry-metadata.test.js
import {
  pypiVersionInfo,
  pypiVersions,
} from "../../server/features/mcp-packages/registry-metadata.js";

const file = (filename, packagetype, sha256, at, extra = {}) => ({
  filename,
  url: `https://files.pythonhosted.org/${filename}`,
  digests: { sha256 },
  packagetype,
  upload_time_iso_8601: at,
  yanked: false,
  requires_python: ">=3.10",
  ...extra,
});
const project = {
  info: { version: "1.1" },
  releases: {
    "1.0": [
      file("x-1.0-py3-none-any.whl", "bdist_wheel", "a", "2026-01-01T00:00:00Z", {
        yanked: true,
      }),
    ],
    1.1: [file("x-1.1.tar.gz", "sdist", "b", "2026-02-01T00:00:00Z")],
    "2.0b1": [
      file("x-2.0b1-py3-none-any.whl", "bdist_wheel", "c", "2026-03-01T00:00:00Z"),
    ],
    0.9: [],
    "1.0-legacy": [file("x-legacy.tar.gz", "sdist", "d", "2025-01-01T00:00:00Z")],
  },
};
const entry = (version, publishedAt, prerelease, yanked) => ({
  version,
  publishedAt,
  prerelease,
  deprecated: false,
  yanked,
});

test("PyPI versions skip empty and non-PEP 440 releases and mark prereleases and yanked ones", () => {
  assert.deepEqual(pypiVersions(project), {
    latest: "1.1",
    versions: [
      entry("2.0b1", "2026-03-01T00:00:00Z", true, false),
      entry("1.1", "2026-02-01T00:00:00Z", false, false),
      entry("1.0", "2026-01-01T00:00:00Z", false, true),
    ],
  });
  assert.deepEqual(pypiVersionInfo(project, "1.1"), {
    files: [
      {
        filename: "x-1.1.tar.gz",
        url: "https://files.pythonhosted.org/x-1.1.tar.gz",
        sha256: "b",
        packagetype: "sdist",
      },
    ],
    requiresPython: ">=3.10",
  });
  assert.throws(() => pypiVersionInfo(project, "0.9"), {
    code: "MCP_PACKAGE_VERSION_NOT_FOUND",
  });
});
```

Also add `yanked: false` to every expected entry of the existing npm test ("versions are newest first with prerelease and deprecated markers").

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/mcp-package-spec.test.js tests/unit/mcp-registry-metadata.test.js`
Expected: FAIL (`pypi` refused; functions missing; npm entries lack `yanked`).

- [ ] **Step 3: Implement**

In `package-spec.js`:

```js
export const registries = ["npm", "pypi"];
// PEP 508 project names; stored in their PEP 503 normalised form.
const pypiName = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/;
export const normalizePypiName = (name) => name.replace(/[-_.]+/g, "-").toLowerCase();
// A public PEP 440 version, exact: no specifier, wildcard, marker or local part.
export const pypiVersionPattern =
  /^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/i;
/** The spelling uv writes into a lock: lowercase, no leading zeros in numbers. */
export const canonicalPypiVersion = (version) =>
  version.toLowerCase().replace(/(^|[.!]|a|b|rc|post|dev)0+(?=\d)/g, "$1");
```

Extend `names` with `pypi: (name) => pypiName.test(name)` and `versions` with `pypi: (version) => version.length <= 128 && pypiVersionPattern.test(version)`. In `packageName` return `registry === "pypi" ? normalizePypiName(name) : name`.

In `registry-metadata.js` (import `pypiVersionPattern` from `./package-spec.js`; reuse the existing `newestFirst`, whose tie-break `compareSemver` only orders equal timestamps):

```js
export const pypiRegistry = "https://pypi.org";
export const pypiProject = (name, { registry = pypiRegistry, download } = {}) =>
  fetchRegistryJson(`${registry}/pypi/${encodeURIComponent(name)}/json`, { download });
const pypiPrerelease = /(?:a|b|rc|\.dev)\d+/i;

export function pypiVersions(project) {
  const versions = Object.entries(project?.releases || {})
    .filter(
      ([version, files]) =>
        Array.isArray(files) && files.length && pypiVersionPattern.test(version),
    )
    .map(([version, files]) => ({
      version,
      publishedAt:
        files
          .map((f) => f.upload_time_iso_8601)
          .filter((at) => typeof at === "string")
          .sort()[0] ?? null,
      prerelease: pypiPrerelease.test(version),
      deprecated: false,
      yanked: files.every((f) => f.yanked === true),
    }))
    .sort(newestFirst);
  return { latest: project?.info?.version ?? null, versions };
}

export function pypiVersionInfo(project, version) {
  const files = project?.releases?.[version];
  if (!Array.isArray(files) || !files.length)
    throw packageProblem("MCP_PACKAGE_VERSION_NOT_FOUND", 404);
  return {
    files: files.map((f) => ({
      filename: f.filename,
      url: f.url,
      sha256: f.digests?.sha256,
      packagetype: f.packagetype,
    })),
    requiresPython: files.find((f) => f.requires_python)?.requires_python ?? null,
  };
}
```

Add `yanked: false` to each entry of `npmVersions`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/mcp-package-spec.test.js tests/unit/mcp-registry-metadata.test.js tests/unit/mcp-package-versions.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-packages/package-spec.js server/features/mcp-packages/registry-metadata.js tests/unit
git commit -m "feat: accept PyPI package references and read their versions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Python lock check

**Files:**

- Create: `server/features/mcp-packages/python-lock-check.js`
- Test: `tests/unit/mcp-python-lock-check.test.js`

**Interfaces:**

- Produces: `checkPythonLock(text, { ref, digests = null })` → `{ digest, dependencies: [{ name, version, path }] }` (`path` = name, so `lockDiff` and the UI keys work unchanged). `digests` (sha256 values PyPI lists for the top release) is checked when given: every top-level hash in the lock must be one of them, else `MCP_PACKAGE_INTEGRITY_MISMATCH`. The top version is compared by `canonicalPypiVersion`.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/mcp-python-lock-check.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { checkPythonLock } from "../../server/features/mcp-packages/python-lock-check.js";

const h = (c) => c.repeat(64);
const ref = { registry: "pypi", name: "mcp-server-time", version: "2026.10.10" };
// The shape `uv pip compile --generate-hashes --no-header` writes.
const lock = (extra = "") => `mcp-server-time==2026.10.10 \\
    --hash=sha256:${h("a")} \\
    --hash=sha256:${h("b")}
    # via -r requirements.in
Tzdata==2026.1 ; sys_platform != "emscripten" \\
    --hash=sha256:${h("c")}
    # via mcp-server-time
${extra}`;

test("a hashed PyPI lock yields normalised dependencies and its digest (D3: markers)", () => {
  const result = checkPythonLock(lock(), { ref, digests: [h("a"), h("b"), h("f")] });
  assert.deepEqual(result.dependencies, [
    { name: "mcp-server-time", version: "2026.10.10", path: "mcp-server-time" },
    { name: "tzdata", version: "2026.1", path: "tzdata" },
  ]);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
});

test("direct URLs, VCS, editable, option and extras lines are foreign (D3)", () => {
  for (const line of [
    `evil @ https://example.com/evil.whl \\\n    --hash=sha256:${h("d")}`,
    "-e git+https://github.com/a/b.git#egg=b",
    "--extra-index-url https://example.com/simple",
    "--index-url https://example.com/simple",
    "--find-links /tmp",
    `b @ file:///tmp/b.whl \\\n    --hash=sha256:${h("d")}`,
    `rich[jupyter]==14.0 \\\n    --hash=sha256:${h("d")}`,
    `c==1.0 --hash=sha256:${h("d")}`,
  ])
    assert.throws(
      () => checkPythonLock(lock(line), { ref }),
      { code: "MCP_PACKAGE_FOREIGN_SOURCE" },
      line,
    );
});

test("a package without a sha256 hash is refused", () => {
  assert.throws(() => checkPythonLock(lock("idna==3.10\n    # via x"), { ref }), {
    code: "MCP_PACKAGE_FOREIGN_SOURCE",
  });
  assert.throws(
    () =>
      checkPythonLock(lock(`idna==3.10 \\\n    --hash=md5:${"a".repeat(32)}`), { ref }),
    { code: "MCP_PACKAGE_FOREIGN_SOURCE" },
  );
});

test("top-level hashes must come from the PyPI release; versions compare canonically", () => {
  assert.throws(() => checkPythonLock(lock(), { ref, digests: [h("a")] }), {
    code: "MCP_PACKAGE_INTEGRITY_MISMATCH",
  });
  assert.throws(() => checkPythonLock(lock(), { ref: { ...ref, version: "1.0" } }), {
    code: "MCP_PACKAGE_INTEGRITY_MISMATCH",
  });
  assert.equal(
    checkPythonLock(lock(), { ref: { ...ref, version: "2026.010.10" } }).dependencies
      .length,
    2,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/mcp-python-lock-check.test.js`
Expected: FAIL with missing module.

- [ ] **Step 3: Implement**

```js
// server/features/mcp-packages/python-lock-check.js
import { lockDigest } from "./lock-check.js";
import { packageProblem } from "./package-errors.js";
import { canonicalPypiVersion, normalizePypiName } from "./package-spec.js";

const foreign = () => packageProblem("MCP_PACKAGE_FOREIGN_SOURCE", 400);
// `name==version`, an optional environment marker (D3), an optional continuation.
// No extras (`name[x]`), URL, path or option fits this pattern.
const requirement =
  /^([A-Za-z0-9][A-Za-z0-9._-]*)==([0-9A-Za-z.!+-]+)(?:\s*;\s*[^\\#]+?)?\s*\\?$/;
const hash = /^--hash=sha256:([0-9a-f]{64})\s*\\?$/;

/**
 * Validates a `uv pip compile --generate-hashes --no-header` lock: only pinned
 * requirements from the configured index, each with at least one sha256 hash.
 */
export function checkPythonLock(text, { ref, digests = null }) {
  const hashes = new Map();
  const versions = new Map();
  let current = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const req = requirement.exec(line);
    if (req) {
      current = normalizePypiName(req[1]);
      if (versions.has(current)) throw foreign();
      versions.set(current, canonicalPypiVersion(req[2]));
      hashes.set(current, []);
      continue;
    }
    const h = hash.exec(line);
    if (h && current) {
      hashes.get(current).push(h[1]);
      continue;
    }
    throw foreign();
  }
  for (const list of hashes.values()) if (!list.length) throw foreign();
  if (versions.get(ref.name) !== canonicalPypiVersion(ref.version))
    throw packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
  if (digests && !hashes.get(ref.name).every((h) => digests.includes(h)))
    throw packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
  const dependencies = [...versions]
    .map(([name, version]) => ({ name, version, path: name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { digest: lockDigest(text), dependencies };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/mcp-python-lock-check.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-packages/python-lock-check.js tests/unit/mcp-python-lock-check.test.js
git commit -m "feat: check hashed Python locks of MCP server packages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Programs from wheels and installed distributions

**Files:**

- Create: `server/features/mcp-packages/wheel-programs.js`
- Modify: `server/features/mcp-packages/package-store.js` (add `pythonCommand`)
- Test: `tests/unit/mcp-wheel-programs.test.js`

**Interfaces:**

- Produces:
  - `consoleScripts(entryPointsText)` → `[{ name, path: name }]` from the `[console_scripts]` section (`path` is the script name under `venv/bin`).
  - `wheelEntryPoints({ python, wheelFile, execute? })` → entry-points text or `""`; runs `python -I -c <reader> <wheelFile>` (reads only the top-level `*.dist-info/entry_points.txt` with `zipfile`; never imports from the wheel).
  - `installedEntryPoints(venvDir, name)` → text of `<site-packages>/<dist>.dist-info/entry_points.txt` for the distribution whose normalised name is `name`, or `""`.
  - `pythonCommand(dataDir, receipt)` → `{ command: <install>/venv/bin/<program.path>, leading: [] }`; same containment as `npmCommand` (`verifiedInstall`, real path inside the install, a file); else `MCP_PACKAGE_NO_PROGRAM`.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/mcp-wheel-programs.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  consoleScripts,
  installedEntryPoints,
} from "../../server/features/mcp-packages/wheel-programs.js";
import {
  commitInstall,
  pythonCommand,
  stageInstall,
} from "../../server/features/mcp-packages/package-store.js";

test("only console_scripts are programs", () => {
  const text =
    "[console_scripts]\nmcp-server-time = mcp_server_time:main\n\n[gui_scripts]\nx = y:z\n";
  assert.deepEqual(consoleScripts(text), [
    { name: "mcp-server-time", path: "mcp-server-time" },
  ]);
  assert.deepEqual(consoleScripts("[console_scripts]\n../x = m:main\n"), []);
  assert.deepEqual(consoleScripts(""), []);
});

test("entry points come from the top distribution, not from dependencies", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "venv-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const site = path.join(dir, "lib", "python3.14", "site-packages");
  for (const [dist, script] of [
    ["mcp_server_time-2026.10.10", "mcp-server-time"],
    ["mcp-2.3.0", "mcp"],
  ]) {
    fs.mkdirSync(path.join(site, `${dist}.dist-info`), { recursive: true });
    fs.writeFileSync(
      path.join(site, `${dist}.dist-info`, "entry_points.txt"),
      `[console_scripts]\n${script} = m:main\n`,
    );
  }
  assert.deepEqual(consoleScripts(installedEntryPoints(dir, "mcp-server-time")), [
    { name: "mcp-server-time", path: "mcp-server-time" },
  ]);
  assert.equal(installedEntryPoints(dir, "missing"), "");
});

test("the Python command is the venv script inside the install", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "py-command-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { installId, stage } = stageInstall(dataDir);
  fs.mkdirSync(path.join(stage, "venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(stage, "venv", "bin", "srv"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  fs.symlinkSync("/bin/sh", path.join(stage, "venv", "bin", "escape"));
  const receipt = { program: { name: "srv", path: "srv" }, lockDigest: "d" };
  const final = commitInstall(dataDir, { installId, stage, receipt });
  assert.deepEqual(pythonCommand(dataDir, { ...receipt, installId }), {
    command: path.join(final, "venv", "bin", "srv"),
    leading: [],
  });
  for (const program of [
    { name: "x", path: "../x" },
    { name: "escape", path: "escape" },
    { name: "none", path: "none" },
  ])
    assert.throws(() => pythonCommand(dataDir, { ...receipt, installId, program }), {
      code: "MCP_PACKAGE_NO_PROGRAM",
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/mcp-wheel-programs.test.js`
Expected: FAIL with missing module and export.

- [ ] **Step 3: Implement**

```js
// server/features/mcp-packages/wheel-programs.js
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizePypiName } from "./package-spec.js";

const executeFile = promisify(execFile);
const scriptName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function consoleScripts(text) {
  const programs = [];
  let section = "";
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) section = line;
    else if (section === "[console_scripts]" && line.includes("=")) {
      const name = line.split("=")[0].trim();
      if (scriptName.test(name)) programs.push({ name, path: name });
    }
  }
  return programs;
}

// Reads one member of a zip; never extracts or imports anything from the wheel.
const reader = [
  "import sys, zipfile",
  "z = zipfile.ZipFile(sys.argv[1])",
  "names = [n for n in z.namelist() if n.count('/') == 1 and n.endswith('.dist-info/entry_points.txt')]",
  "sys.stdout.write(z.read(names[0]).decode('utf-8') if names else '')",
].join("\n");

export async function wheelEntryPoints({ python, wheelFile, execute = executeFile }) {
  const { stdout } = await execute(python.pythonPath, ["-I", "-c", reader, wheelFile], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

export function installedEntryPoints(venvDir, name) {
  const lib = path.join(venvDir, "lib");
  for (const version of fs.existsSync(lib) ? fs.readdirSync(lib) : []) {
    const site = path.join(lib, version, "site-packages");
    for (const entry of fs.existsSync(site) ? fs.readdirSync(site) : []) {
      if (!entry.endsWith(".dist-info")) continue;
      const dist = entry.slice(0, -".dist-info".length).replace(/-[^-]+$/, "");
      if (normalizePypiName(dist) !== name) continue;
      const file = path.join(site, entry, "entry_points.txt");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    }
  }
  return "";
}
```

`package-store.js` addition (next to `npmCommand`, reusing its private `verifiedInstall`):

```js
/** The venv's console script of the program, contained in the install. */
export function pythonCommand(dataDir, receipt) {
  try {
    const directory = verifiedInstall(dataDir, receipt.installId);
    const bin = path.join(directory, "venv", "bin");
    const program = path.join(bin, receipt.program.path);
    if (path.dirname(program) !== bin) throw Error("outside");
    const stat = fs.lstatSync(program);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("not a script");
    if (!fs.realpathSync(program).startsWith(fs.realpathSync(directory) + path.sep))
      throw Error("outside");
    return { command: program, leading: [] };
  } catch {
    throw packageProblem("MCP_PACKAGE_NO_PROGRAM", 502);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/mcp-wheel-programs.test.js tests/unit/mcp-package-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-packages/wheel-programs.js server/features/mcp-packages/package-store.js \
  tests/unit/mcp-wheel-programs.test.js
git commit -m "feat: find console scripts of Python MCP server packages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Registry adapters, preview cap and program after install (npm only)

This task changes no npm behaviour; it moves the npm calls behind the adapter so Task 6 adds Python without touching them.

**Files:**

- Create: `server/features/mcp-packages/npm-adapter.js`
- Modify: `server/features/mcp-packages/mcp-packages.js`, `server/features/mcp-packages/package-install-job.js`
- Modify: `server/lib/i18n/de/mcp-packages.js`, `server/lib/i18n/en/mcp-packages.js` (`previewBusy`)
- Test: extend `tests/unit/mcp-packages-service.test.js`; rerun every plan 2 suite

**Interfaces:**

- Adapter (an object with exactly these members):
  - `toolchainKind`: `"node"` | `"python"`.
  - `versions(name, { registry, download })` → `{ latest, versions }`.
  - `preview({ ref, allowScripts, toolchain, stage, registry, download, cacheDir, execute, environment })` → `{ integrity, programs: [{ name, path }], needsScripts, manifestText, lockText, digest, dependencies }`. `toolchain` is a loader `() => Promise<toolchain>`, so metadata errors (`MCP_PACKAGE_NO_PROGRAM`, `MCP_PACKAGE_VERSION_NOT_FOUND`) still come before any toolchain install, as in plan 2. `lockText` is `null` only when a build is needed and not allowed.
  - `checkStored({ lockText, ref, integrity }, { registry })` → `{ digest, dependencies }`.
  - `manifestText(ref)` → the npm `package.json` or the Python `requirements.in`.
  - `install({ directory, preview, toolchain, registry, cacheDir, execute, environment, log })` → void.
  - `programsAfterInstall(directory, ref)` → `null` (npm: chosen at preview) or `[{ name, path }]` (Python: the installed top distribution's console scripts).
  - `command(dataDir, receipt, toolchain)` → `{ command, leading }`.
  - `toolchainVersion(toolchain)` → string for the receipt.
- `McpPackages`:
  - constructor keeps `registry` (npm URL, normalised as today) and gains `adapters = { npm: npmAdapter }` and `previewConcurrency = 2`; `this.registries = { npm: this.registry }` (Task 6 adds `pypi`).
  - `adapterOf(registry)` → adapter or `MCP_PACKAGE_INVALID`.
  - `cacheDir(registry)` replaces the `cacheDir` getter: `.npm-cache` for npm, `.uv-cache` for pypi, under `packageRoot`.
  - `checkStored({ registry, name, version, lock, integrity })` replaces `checkLock`; used by the preview diff, `reinstall` and `runInstall`.
  - `confirmedPreview` checks needs-scripts **before** the program and returns `program: null`-like `{ name: wanted ?? "", path: "" }` when the preview lists no programs.
- `sourceFields(preview, program)` stores `program?.name ?? ""` and `program?.path ?? ""`.

- [ ] **Step 1: Write the failing tests**

```js
// add to tests/unit/mcp-packages-service.test.js
const heldAdapter = () => {
  const waiting = [];
  return {
    waiting,
    adapter: {
      toolchainKind: "node",
      versions: async () => ({ latest: null, versions: [] }),
      preview: () =>
        new Promise((resolve) =>
          waiting.push(() =>
            resolve({
              integrity: "sha512-top",
              programs: [{ name: "x", path: "index.js" }],
              needsScripts: false,
              manifestText: "{}",
              lockText: "{}",
              digest: "d",
              dependencies: [],
            }),
          ),
        ),
    },
  };
};

test("at most two previews resolve at once; a third is busy", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-preview-cap-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const held = heldAdapter();
  const service = new McpPackages({
    dataDir,
    servers: { packages: { get: () => null } },
    changes: {},
    toolchain: async () => ({}),
    adapters: { npm: held.adapter },
  });
  const ref = { registry: "npm", name: "x", version: "1.0.0" };
  const first = service.preview(ref);
  const second = service.preview(ref);
  await assert.rejects(service.preview(ref), (error) => {
    assert.equal(error.code, "MCP_PACKAGE_BUSY");
    assert.equal(error.status, 409);
    assert.match(error.message, /Pakete|packages/);
    return true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  held.waiting.splice(0).forEach((open) => open());
  await Promise.all([first, second]);
  const third = service.preview(ref);
  await new Promise((resolve) => setImmediate(resolve));
  held.waiting.splice(0).forEach((open) => open());
  assert.equal((await third).programs[0], "x");
});

test("a preview that needs a build is refused for that before its programs", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-needs-build-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const service = new McpPackages({
    dataDir,
    servers: { packages: { get: () => null } },
    changes: {},
    toolchain: async () => ({}),
    adapters: {
      npm: {
        toolchainKind: "node",
        preview: async () => ({
          integrity: "sha256:a",
          programs: [],
          needsScripts: true,
          manifestText: "x==1\n",
          lockText: null,
          digest: null,
          dependencies: [],
        }),
      },
    },
  });
  const ref = { registry: "npm", name: "x", version: "1.0.0" };
  const preview = await service.preview(ref);
  assert.deepEqual(preview.programs, []);
  assert.throws(() => service.confirmedPreview(preview.previewId, ref), {
    code: "MCP_PACKAGE_NEEDS_SCRIPTS",
  });
});
```

(The second test uses the npm slot only to inject a stub; the Python adapter reaches the same branch in Task 6.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/mcp-packages-service.test.js`
Expected: FAIL (`adapters` option ignored; no cap; `MCP_PACKAGE_NO_PROGRAM` instead of `MCP_PACKAGE_NEEDS_SCRIPTS`).

- [ ] **Step 3: Server copy**

`server/lib/i18n/en/mcp-packages.js`: `previewBusy: "Several packages are being checked right now. Please try again shortly.",`
`server/lib/i18n/de/mcp-packages.js`: `previewBusy: "Gerade werden schon mehrere Pakete geprüft. Bitte gleich noch einmal versuchen.",`

- [ ] **Step 4: Create the npm adapter**

```js
// server/features/mcp-packages/npm-adapter.js
import { checkNpmLock } from "./lock-check.js";
import { installNpm, npmManifestText, resolveNpm } from "./npm-package-install.js";
import { packageProblem } from "./package-errors.js";
import { npmCommand } from "./package-store.js";
import { npmPrograms } from "./program-select.js";
import { npmPackument, npmVersionInfo, npmVersions } from "./registry-metadata.js";

/** Plan 2's npm calls behind the registry adapter interface (mcp-packages.js). */
export const npmAdapter = {
  toolchainKind: "node",
  async versions(name, { registry, download }) {
    return npmVersions(await npmPackument(name, { registry, download }));
  },
  async preview({
    ref,
    toolchain,
    stage,
    registry,
    download,
    cacheDir,
    execute,
    environment,
  }) {
    const info = npmVersionInfo(
      await npmPackument(ref.name, { registry, download }),
      ref.version,
    );
    const programs = npmPrograms(ref.name, info.bin);
    if (!programs.length) throw packageProblem("MCP_PACKAGE_NO_PROGRAM", 400);
    const node = await toolchain();
    const resolved = await resolveNpm({
      stage,
      ref,
      node,
      registry,
      cacheDir,
      execute,
      environment,
    });
    const checked = checkNpmLock(resolved.lockText, {
      ref,
      integrity: info.integrity,
      registry,
    });
    return {
      integrity: info.integrity,
      programs,
      needsScripts: checked.needsScripts || info.installScripts,
      manifestText: resolved.manifestText,
      lockText: resolved.lockText,
      digest: checked.digest,
      dependencies: checked.dependencies,
    };
  },
  checkStored({ lockText, ref, integrity }, { registry }) {
    return checkNpmLock(lockText, { ref, integrity, registry });
  },
  manifestText: npmManifestText,
  install({
    directory,
    preview,
    toolchain,
    registry,
    cacheDir,
    execute,
    environment,
    log,
  }) {
    return installNpm({
      directory,
      manifestText: preview.manifestText,
      lockText: preview.lockText,
      ref: preview.ref,
      node: toolchain,
      registry,
      cacheDir,
      allowScripts: preview.allowScripts,
      execute,
      environment,
      log,
    });
  },
  programsAfterInstall: () => null,
  command: (dataDir, receipt, toolchain) => npmCommand(dataDir, receipt, toolchain),
  toolchainVersion: (toolchain) => toolchain.version,
};
```

- [ ] **Step 5: Route `McpPackages` through the adapter**

In `mcp-packages.js` remove the imports of `checkNpmLock`, `npmManifestText`, `resolveNpm`, `npmPrograms`, `npmPackument`, `npmVersionInfo`, `npmVersions` and import `npmAdapter`. Then:

```js
// constructor parameters: add
//   adapters = { npm: npmAdapter },
//   previewConcurrency = 2,
// and after Object.assign:
this.adapters = adapters;
this.previewConcurrency = previewConcurrency;
this.registries = { npm: this.registry };
this.resolving = 0;

adapterOf(registry) {
  const adapter = Object.hasOwn(this.adapters, registry) ? this.adapters[registry] : null;
  if (!adapter) throw invalid();
  return adapter;
}
cacheDir(registry) {
  return path.join(packageRoot(this.dataDir), registry === "pypi" ? ".uv-cache" : ".npm-cache");
}
/** A stored or previewed lock, checked again by its registry's adapter. */
checkStored({ registry, name, version, lock, integrity }) {
  const ref = packageRef({ registry, name, version });
  return this.adapterOf(registry).checkStored(
    { lockText: lock, ref, integrity },
    { registry: this.registries[registry] },
  );
}
async versions(input) {
  const name = packageName(input);
  return this.adapterOf(input.registry).versions(name, {
    registry: this.registries[input.registry],
    download: this.download,
  });
}
async resolvePreview(ref, input) {
  const allowScripts = input.allowScripts === true;
  const adapter = this.adapterOf(ref.registry);
  // Each resolve runs npm or uv; more than a few at once only queue on the host.
  if (this.resolving >= this.previewConcurrency)
    throw packageProblem("MCP_PACKAGE_BUSY", 409, "previewBusy");
  this.resolving += 1;
  const previewId = randomUUID();
  // Previews resolve outside installs/, so pruning never races a running preview.
  const stage = path.join(packageRoot(this.dataDir), "previews", previewId);
  let resolved;
  try {
    resolved = await adapter.preview({
      ref,
      allowScripts,
      toolchain: () => this.toolchain(adapter.toolchainKind),
      stage: privateFolder(stage),
      registry: this.registries[ref.registry],
      download: this.download,
      cacheDir: this.cacheDir(ref.registry),
      execute: this.execute,
      environment: this.environment,
    });
  } finally {
    this.resolving -= 1;
    fs.rmSync(stage, { recursive: true, force: true });
  }
  const current = input.serverId ? this.records.get(input.serverId) : null;
  const diff =
    current && resolved.lockText
      ? lockDiff(this.checkStored(current).dependencies, resolved.dependencies)
      : null;
  this.previews.set(previewId, {
    ref,
    allowScripts,
    ...resolved,
    expires: this.now() + this.previewTtl,
  });
  while (this.previews.size > previewLimit)
    this.previews.delete(this.previews.keys().next().value);
  return {
    previewId,
    ...ref,
    integrity: resolved.integrity,
    dependencyCount: resolved.dependencies.length,
    dependencies: resolved.dependencies,
    programs: resolved.programs.map((p) => p.name),
    needsScripts: resolved.needsScripts,
    diff,
  };
}
confirmedPreview(previewId, source, wanted) {
  const preview = this.takePreview(previewId, source);
  // Before the program: a package that must be built names its programs only then.
  if (preview.needsScripts === true && !preview.allowScripts)
    throw packageProblem("MCP_PACKAGE_NEEDS_SCRIPTS", 400);
  const program = preview.programs.length
    ? chooseProgram(preview.programs, wanted)
    : { name: typeof wanted === "string" ? wanted : "", path: "" };
  return { preview, program };
}
```

`updatePackage`: pass `program ?? (row.program || undefined)` (a pending Python row stores `""`). `reinstall`:

```js
const ref = packageRef(row);
const preview = {
  ref,
  allowScripts: row.allowScripts,
  integrity: row.integrity,
  manifestText: this.adapterOf(ref.registry).manifestText(ref),
  lockText: row.lock,
  digest: row.lockDigest,
};
this.checkStored(row);
```

Delete the `cacheDir` getter and `checkLock`.

- [ ] **Step 6: Route `runInstall` through the adapter**

In `package-install-job.js` drop the `installNpm` and `npmCommand` imports, import `chooseProgram` from `./program-select.js`, change `sourceFields` to `program: program?.name ?? ""`, `programPath: program?.path ?? ""`, and replace the job body's install part:

```js
const { ref } = preview;
const adapter = service.adapterOf(ref.registry);
// Never install from an unchecked lock, even one checked at preview time.
const checked = service.checkStored({
  ...ref,
  lock: preview.lockText,
  integrity: preview.integrity,
});
if (checked.digest !== preview.digest)
  throw packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
const toolchain = await service.toolchain(adapter.toolchainKind);
const toolchainDir = toolchainEntry(service.dataDir, toolchain?.directory);
if (!toolchainDir) throw packageProblem("MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE", 503);
note({ toolchainDir });
await adapter.install({
  directory: stage,
  preview,
  toolchain,
  registry: service.registries[ref.registry],
  cacheDir: service.cacheDir(ref.registry),
  execute: service.execute,
  environment: service.environment,
  log,
});
// Python names its programs for sure only once installed (and built).
const installed = adapter.programsAfterInstall(stage, ref);
const chosen = installed ? chooseProgram(installed, program?.name || undefined) : program;
const receipt = {
  ...ref,
  integrity: preview.integrity,
  lockDigest: checked.digest,
  allowScripts: preview.allowScripts,
  program: chosen,
  toolchain: {
    kind: adapter.toolchainKind,
    version: adapter.toolchainVersion(toolchain),
    directory: toolchainDir,
  },
};
commitInstall(service.dataDir, { installId, stage, receipt });
const { command, leading } = adapter.command(
  service.dataDir,
  { ...receipt, installId },
  toolchain,
);
await activate(
  service,
  serverId,
  {
    ...sourceFields(preview, chosen),
    installId,
    leadingArgs: leading.length,
    toolchainDir,
    status: "ready",
    errorCode: null,
  },
  command,
  leading,
);
```

- [ ] **Step 7: Run every package suite**

Run: `node --test tests/unit/mcp-packages-service.test.js tests/unit/mcp-package-*.test.js tests/unit/mcp-lock-check.test.js tests/unit/mcp-program-select.test.js tests/unit/mcp-registry-metadata.test.js tests/integration/mcp-packages-service.test.js tests/integration/mcp-packages-service-recovery.test.js tests/integration/mcp-packages-routes.test.js tests/integration/mcp-npm-install.test.js && node --test tests/unit/i18n-*.test.js tests/unit/server-i18n-catalogs.test.js`
Expected: PASS, with no plan 2 test changed. `wc -l server/features/mcp-packages/mcp-packages.js server/features/mcp-packages/package-install-job.js` stays below 600.

- [ ] **Step 8: Commit**

```bash
git add server/features/mcp-packages server/lib/i18n tests/unit/mcp-packages-service.test.js
git commit -m "refactor: install MCP packages through registry adapters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Python installer

**Files:**

- Create: `server/features/mcp-packages/python-package-install.js`
- Test: `tests/unit/mcp-python-install.test.js`

**Interfaces:**

- `uvEnvironment({ work, index, cacheDir, environment, allowScripts })` → env object (Global Constraints).
- `resolvePython({ stage, ref, python, index, cacheDir, allowScripts, execute?, environment?, log? })` → `{ requirementsText, lockText, needsScripts }`; when the trial compile reports no usable wheels: `needsScripts: true` and, without `allowScripts`, `lockText: null`.
- `installPython({ directory, requirementsText, lockText, python, index, cacheDir, allowScripts, execute?, environment?, log? })` → void (venv at `<directory>/venv`, `requirements.in` and `requirements.lock` beside it).

- [ ] **Step 1: Write the failing test (fake `execute`, no network)**

```js
// tests/unit/mcp-python-install.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installPython,
  resolvePython,
  uvEnvironment,
} from "../../server/features/mcp-packages/python-package-install.js";

const python = { uvPath: "/tc/uv/uv", pythonPath: "/tc/cpython/bin/python3" };
const ref = { registry: "pypi", name: "srv-x", version: "1.0" };
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-uv-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const failure = (stderr) => Object.assign(Error("uv"), { stdout: "", stderr });

test("the uv environment is built from scratch; compilers only with the opt-in", (t) => {
  const dir = tmp(t);
  const options = {
    work: dir,
    index: "https://pypi.org/simple",
    cacheDir: path.join(dir, "cache"),
    environment: {
      HTTPS_PROXY: "http://proxy:3128",
      UV_INDEX_URL: "https://evil",
      PIP_INDEX_URL: "x",
    },
  };
  const env = uvEnvironment({ ...options, allowScripts: false });
  assert.equal(env.UV_INDEX_URL, "https://pypi.org/simple");
  assert.equal(env.UV_NO_CONFIG, "1");
  assert.equal(env.UV_PYTHON_DOWNLOADS, "never");
  assert.equal(env.UV_LINK_MODE, "copy");
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HTTPS_PROXY, "http://proxy:3128");
  assert.equal(env.PIP_INDEX_URL, undefined);
  assert.equal(env.CC, undefined);
  const build = uvEnvironment({ ...options, allowScripts: true });
  assert.equal(build.CC, "cc");
  assert.equal(build.CXX, "c++");
});

test("a wheel-only resolve compiles once, hashed, headerless, for the managed Python", async (t) => {
  const calls = [];
  const execute = async (file, args) => {
    calls.push({ file, args });
    fs.writeFileSync(
      args[args.indexOf("-o") + 1],
      "srv-x==1.0 \\\n    --hash=sha256:x\n",
    );
    return { stdout: "", stderr: "" };
  };
  const result = await resolvePython({
    stage: tmp(t),
    ref,
    python,
    index: "http://i/simple",
    cacheDir: path.join(tmp(t), "c"),
    allowScripts: false,
    execute,
    environment: {},
  });
  assert.equal(result.needsScripts, false);
  assert.equal(result.requirementsText, "srv-x==1.0\n");
  assert.match(result.lockText, /^srv-x==1\.0/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, python.uvPath);
  for (const flag of [
    "compile",
    "--generate-hashes",
    "--no-header",
    "--no-annotate",
    "--only-binary",
    ":all:",
  ])
    assert.ok(calls[0].args.includes(flag), flag);
  assert.equal(calls[0].args[calls[0].args.indexOf("--python") + 1], python.pythonPath);
});

test("no usable wheels: needs scripts; built only with the opt-in", async (t) => {
  const noWheel = failure(
    "Because old-x==1.0 has no usable wheels and you require old-x==1.0 …\nhint: Wheels are required for `old-x`",
  );
  let calls = 0;
  const execute = async (file, args) => {
    calls += 1;
    if (args.includes("--only-binary")) throw noWheel;
    fs.writeFileSync(
      args[args.indexOf("-o") + 1],
      "old-x==1.0 \\\n    --hash=sha256:y\n",
    );
    return { stdout: "", stderr: "" };
  };
  const base = { ref, python, index: "http://i/simple", execute, environment: {} };
  const refused = await resolvePython({
    ...base,
    stage: tmp(t),
    cacheDir: tmp(t),
    allowScripts: false,
  });
  assert.deepEqual([refused.needsScripts, refused.lockText, calls], [true, null, 1]);
  const built = await resolvePython({
    ...base,
    stage: tmp(t),
    cacheDir: tmp(t),
    allowScripts: true,
  });
  assert.equal(built.needsScripts, true);
  assert.match(built.lockText, /^old-x==1\.0/);
});

test("any other compile failure is an install failure", async (t) => {
  const execute = async () => {
    throw failure(
      "Because the current Python version (3.14.7) does not satisfy Python>=3.15 …",
    );
  };
  await assert.rejects(
    resolvePython({
      stage: tmp(t),
      ref,
      python,
      index: "http://i/simple",
      cacheDir: tmp(t),
      allowScripts: false,
      execute,
      environment: {},
    }),
    { code: "MCP_PACKAGE_INSTALL_FAILED" },
  );
});

test("install creates a relocatable venv and syncs the lock with hashes", async (t) => {
  const directory = path.join(tmp(t), ".stage-x");
  const calls = [];
  const execute = async (file, args, options) => {
    calls.push({ args, env: options.env });
    return { stdout: "", stderr: "" };
  };
  const base = {
    directory,
    requirementsText: "srv-x==1.0\n",
    lockText: "lock\n",
    python,
    index: "http://i/simple",
    cacheDir: tmp(t),
    execute,
    environment: {},
  };
  await installPython({ ...base, allowScripts: false });
  assert.deepEqual(calls[0].args, [
    "venv",
    "--relocatable",
    "--python",
    python.pythonPath,
    path.join(directory, "venv"),
  ]);
  assert.deepEqual(calls[1].args.slice(0, 3), [
    "pip",
    "sync",
    path.join(directory, "requirements.lock"),
  ]);
  for (const flag of ["--require-hashes", "--only-binary", ":all:"])
    assert.ok(calls[1].args.includes(flag), flag);
  assert.equal(
    calls[1].args[calls[1].args.indexOf("--python") + 1],
    path.join(directory, "venv", "bin", "python"),
  );
  assert.equal(
    fs.readFileSync(path.join(directory, "requirements.lock"), "utf8"),
    "lock\n",
  );
  assert.equal(fs.existsSync(path.join(directory, ".uv-work")), false);
  calls.length = 0;
  await installPython({
    ...base,
    directory: path.join(tmp(t), ".stage-y"),
    allowScripts: true,
  });
  assert.equal(calls[1].args.includes("--only-binary"), false);
  assert.equal(calls[1].env.CC, "cc");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/mcp-python-install.test.js`
Expected: FAIL with missing module.

- [ ] **Step 3: Implement**

```js
// server/features/mcp-packages/python-package-install.js
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { proxyEnvironment } from "../../lib/proxy-environment.js";
import { packageProblem } from "./package-errors.js";
import { privateFolder } from "./verified-files.js";

const executeFile = promisify(execFile);
const failed = () => packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502);
// uv 0.12.21 (preflight B4): "<pkg> has no usable wheels" plus "Wheels are required for".
const noWheel = /has no usable wheels|Wheels are required for/;

/**
 * Only proxy variables are inherited; uv reads no config file and downloads no
 * Python. Source builds (opt-in) use the system `cc`: CPython's sysconfig names
 * `clang`, which a Linux host often lacks (preflight B12).
 */
export function uvEnvironment({ work, index, cacheDir, environment, allowScripts }) {
  for (const name of ["home", "tmp"]) privateFolder(path.join(work, name));
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
    ...(allowScripts === true ? { CC: "cc", CXX: "c++" } : {}),
  };
}

async function uv(python, args, { env, execute, log }) {
  try {
    const { stdout, stderr } = await execute(python.uvPath, args, {
      env,
      timeout: 600000,
      maxBuffer: 4 * 1024 * 1024,
    });
    log?.(`${stdout}\n${stderr}`);
    return { ok: true, stderr: String(stderr || "") };
  } catch (error) {
    log?.(`${error.stdout || ""}\n${error.stderr || ""}`);
    return { ok: false, stderr: String(error.stderr || "") };
  }
}

/** Resolves `name==version` to a hashed lock; builds nothing without the opt-in. */
export async function resolvePython({
  stage,
  ref,
  python,
  index,
  cacheDir,
  allowScripts,
  execute = executeFile,
  environment = process.env,
  log,
}) {
  const work = privateFolder(path.join(stage, ".uv-work"));
  try {
    const env = uvEnvironment({ work, index, cacheDir, environment, allowScripts });
    const requirementsText = `${ref.name}==${ref.version}\n`;
    const input = path.join(work, "requirements.in");
    const output = path.join(work, "requirements.lock");
    fs.writeFileSync(input, requirementsText, { mode: 0o600 });
    const compile = (extra) =>
      uv(
        python,
        [
          "pip",
          "compile",
          input,
          "--generate-hashes",
          "--no-header",
          "--no-annotate",
          "--python",
          python.pythonPath,
          "-o",
          output,
          ...extra,
        ],
        { env, execute, log },
      );
    const trial = await compile(["--only-binary", ":all:"]);
    let needsScripts = false;
    if (!trial.ok) {
      if (!noWheel.test(trial.stderr)) throw failed();
      needsScripts = true;
      if (allowScripts !== true)
        return { requirementsText, lockText: null, needsScripts };
      if (!(await compile([])).ok) throw failed();
    }
    return { requirementsText, lockText: fs.readFileSync(output, "utf8"), needsScripts };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Installs a checked lock into `<directory>/venv`; sdists build only with the opt-in. */
export async function installPython({
  directory,
  requirementsText,
  lockText,
  python,
  index,
  cacheDir,
  allowScripts,
  execute = executeFile,
  environment = process.env,
  log,
}) {
  privateFolder(directory);
  const lock = path.join(directory, "requirements.lock");
  fs.writeFileSync(path.join(directory, "requirements.in"), requirementsText, {
    mode: 0o600,
  });
  fs.writeFileSync(lock, lockText, { mode: 0o600 });
  const work = privateFolder(path.join(directory, ".uv-work"));
  try {
    const env = uvEnvironment({ work, index, cacheDir, environment, allowScripts });
    const venv = path.join(directory, "venv");
    const created = await uv(
      python,
      ["venv", "--relocatable", "--python", python.pythonPath, venv],
      { env, execute, log },
    );
    if (!created.ok) throw failed();
    const synced = await uv(
      python,
      [
        "pip",
        "sync",
        lock,
        "--require-hashes",
        "--python",
        path.join(venv, "bin", "python"),
        ...(allowScripts === true ? [] : ["--only-binary", ":all:"]),
      ],
      { env, execute, log },
    );
    if (!synced.ok) throw failed();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/mcp-python-install.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-packages/python-package-install.js tests/unit/mcp-python-install.test.js
git commit -m "feat: resolve and install Python MCP packages with uv

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: PyPI adapter, service wiring and real installs against a local index

**Files:**

- Create: `server/features/mcp-packages/python-adapter.js`
- Modify: `server/features/mcp-packages/mcp-packages.js` (register the adapter and `pypi` option)
- Create: `tests/helpers/pypi-index-fixture.js`, `tests/helpers/mcp-python-service.js`
- Test: `tests/integration/mcp-python-packages.test.js` (gated by `AGENTPIER_MCP_PYTHON_TESTS=1`; it downloads the real toolchain once)
- Modify: `.github/workflows/mcp-toolchains.yml`, `tests/unit/mcp-toolchains-workflow.test.js`

**Interfaces:**

- `pypiIndexRegistry` = `{ api: "https://pypi.org", index: "https://pypi.org/simple" }`.
- `McpPackages` constructor gains `pypi = pypiIndexRegistry`; `adapters` default becomes `{ npm: npmAdapter, pypi: pythonAdapter }`; `this.registries = { npm: this.registry, pypi }`.
- `pythonAdapter.preview` downloads the top release's wheel (`py3-none-any` first, else any wheel) from `files.pythonhosted.org` (any host when a test index is injected), checks its sha256 against PyPI, reads `entry_points.txt`; a wheel without console scripts → `MCP_PACKAGE_NO_PROGRAM`; no wheel at all (sdist-only top package) → `programs: []` (chosen after the build).
- `pypiIndexFixture(t, python, packages)` → `{ api, index }`; a package is `{ name, version, script?, requires?, sdistOnly?, sdist?: "c-extension", file? }` (`file`: a prebuilt artifact served as is).
- `pythonPackageService(t, packages)` → `cliMcpFixture` plus `{ python, index, packages: McpPackages }`; the toolchain is `ensureToolchain("python", { dataDir: $TMPDIR/agentpier-test-toolchains })`, shared by every test run on the machine.

- [ ] **Step 1: Build the local index fixture**

```js
// tests/helpers/pypi-index-fixture.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// A minimal wheel with a correct RECORD, written by the managed CPython's zipfile.
const wheelBuilder = String.raw`
import sys, zipfile, json, hashlib, base64
spec = json.loads(sys.argv[2])
dist = spec["module"] + "-" + spec["version"]
files = {spec["module"] + "/__init__.py": "def main():\n    print('ok')\n"}
meta = "Metadata-Version: 2.1\nName: %s\nVersion: %s\n" % (spec["name"], spec["version"])
for dep in spec.get("requires", []):
    meta += "Requires-Dist: %s\n" % dep
files[dist + ".dist-info/METADATA"] = meta
files[dist + ".dist-info/WHEEL"] = "Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
if spec.get("script"):
    files[dist + ".dist-info/entry_points.txt"] = "[console_scripts]\n%s = %s:main\n" % (spec["script"], spec["module"])
record = []
with zipfile.ZipFile(sys.argv[1], "w") as z:
    for name, text in files.items():
        data = text.encode()
        z.writestr(name, data)
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        record.append("%s,sha256=%s,%d" % (name, digest, len(data)))
    record.append(dist + ".dist-info/RECORD,,")
    z.writestr(dist + ".dist-info/RECORD", "\n".join(record) + "\n")
`;

// A real setuptools sdist with one C extension and a console script (Task 7).
const sdistBuilder = String.raw`
import sys, tarfile, io, json
spec = json.loads(sys.argv[2])
m, root = spec["module"], spec["module"] + "-" + spec["version"]
c = '''#include <Python.h>
static PyObject* hi(PyObject* s, PyObject* a) { return PyUnicode_FromString("built"); }
static PyMethodDef M[] = {{"hi", hi, METH_NOARGS, ""}, {0}};
static struct PyModuleDef D = {PyModuleDef_HEAD_INIT, "_hello", 0, -1, M};
PyMODINIT_FUNC PyInit__hello(void) { return PyModule_Create(&D); }
'''
files = {
    "PKG-INFO": "Metadata-Version: 2.1\nName: %s\nVersion: %s\n" % (spec["name"], spec["version"]),
    "pyproject.toml": '[build-system]\nrequires = ["setuptools"]\nbuild-backend = "setuptools.build_meta"\n',
    "setup.py": "from setuptools import setup, Extension\nsetup(name=%r, version=%r, packages=[%r], ext_modules=[Extension(%r, [%r])], entry_points={'console_scripts': [%r]})\n"
        % (spec["name"], spec["version"], m, m + "._hello", m + "/_hello.c", "%s = %s:main" % (spec["script"], m)),
    m + "/__init__.py": "from %s._hello import hi\ndef main():\n    print(hi())\n" % m,
    m + "/_hello.c": c,
}
with tarfile.open(sys.argv[1], "w:gz") as tar:
    for name, text in files.items():
        data = text.encode()
        info = tarfile.TarInfo(root + "/" + name)
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
`;

function artifact(work, python, pkg) {
  const module = pkg.name.replace(/-/g, "_");
  if (pkg.file)
    return {
      file: pkg.file,
      packagetype: pkg.file.endsWith(".whl") ? "bdist_wheel" : "sdist",
    };
  const sdist = pkg.sdistOnly || pkg.sdist;
  const file = path.join(
    work,
    sdist
      ? `${module}-${pkg.version}.tar.gz`
      : `${module}-${pkg.version}-py3-none-any.whl`,
  );
  if (pkg.sdistOnly) fs.writeFileSync(file, "not a real sdist");
  else
    execFileSync(python.pythonPath, [
      "-I",
      "-c",
      pkg.sdist ? sdistBuilder : wheelBuilder,
      file,
      JSON.stringify({ ...pkg, module }),
    ]);
  return { file, packagetype: sdist ? "sdist" : "bdist_wheel" };
}

/** A PEP 503 simple index plus the PyPI JSON API for `packages`, on 127.0.0.1. */
export async function pypiIndexFixture(t, python, packages) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pypi-index-"));
  const files = new Map();
  const projects = new Map();
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("#")[0].split("?")[0]);
    if (files.has(url)) return res.end(files.get(url));
    const simple = /^\/simple\/([^/]+)\/?$/.exec(url);
    if (simple && projects.has(simple[1])) {
      res.setHeader("content-type", "text/html");
      return res.end(
        `<html><body>${projects.get(simple[1]).links.join("\n")}</body></html>`,
      );
    }
    const json = /^\/pypi\/([^/]+)\/json$/.exec(url);
    if (json && projects.has(json[1])) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(projects.get(json[1]).json));
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  });
  for (const pkg of packages) {
    const { file, packagetype } = artifact(work, python, pkg);
    const filename = path.basename(file);
    const bytes = fs.readFileSync(file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    files.set(`/files/${filename}`, bytes);
    const project = projects.get(pkg.name) || {
      links: [],
      json: { info: { version: pkg.version }, releases: {} },
    };
    project.links.push(
      `<a href="${base}/files/${filename}#sha256=${sha256}">${filename}</a>`,
    );
    project.json.info.version = pkg.version;
    project.json.releases[pkg.version] = [
      ...(project.json.releases[pkg.version] || []),
      {
        filename,
        url: `${base}/files/${filename}`,
        digests: { sha256 },
        packagetype,
        upload_time_iso_8601: "2026-10-01T00:00:00Z",
        yanked: false,
        requires_python: ">=3.10",
      },
    ];
    projects.set(pkg.name, project);
  }
  return { api: base, index: `${base}/simple` };
}
```

```js
// tests/helpers/mcp-python-service.js
import os from "node:os";
import path from "node:path";
import { cliMcpFixture } from "./cli-mcp.js";
import { pypiIndexFixture } from "./pypi-index-fixture.js";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";
import { McpPackages } from "../../server/features/mcp-packages/mcp-packages.js";
import { ensureToolchain } from "../../server/features/mcp-packages/toolchains.js";

/** One real toolchain per machine, outside the per-test data dirs. */
export const sharedToolchains = path.join(os.tmpdir(), "agentpier-test-toolchains");
export const sharedPython = () =>
  ensureToolchain("python", { dataDir: sharedToolchains });

/** McpPackages over a local PyPI index with the real uv and CPython (plan 1). */
export async function pythonPackageService(t, published) {
  const python = await sharedPython();
  const index = await pypiIndexFixture(t, python, published);
  const f = cliMcpFixture(t);
  const changes = new CentralMcpChanges({ servers: f.servers });
  const packages = new McpPackages({
    dataDir: f.dataDir,
    servers: f.servers,
    changes,
    pypi: index,
    environment: {},
    download: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw Object.assign(Error("x"), { status: response.status });
      return Buffer.from(await response.arrayBuffer());
    },
    toolchain: async (kind) => {
      if (kind !== "python") throw Error(`unexpected toolchain ${kind}`);
      return python;
    },
  });
  return { ...f, python, index, packages };
}

export const pypiRef = (name, version = "1.0") => ({ registry: "pypi", name, version });

/** A packaged server created from a fresh preview, after its job settled. */
export async function createPython(s, name, extra = {}) {
  const preview = await s.packages.preview({ ...pypiRef(name), ...extra });
  const server = await s.packages.createServer(
    { name: `py-${name}`, transport: "stdio", source: { ...pypiRef(name), ...extra } },
    { previewId: preview.previewId },
  );
  await s.packages.jobs.idle();
  return { preview, server: s.servers.get(server.id) };
}
```

- [ ] **Step 2: Write the failing integration test**

```js
// tests/integration/mcp-python-packages.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createPython,
  pypiRef,
  pythonPackageService,
} from "../helpers/mcp-python-service.js";

const skip = process.env.AGENTPIER_MCP_PYTHON_TESTS !== "1";
const server = {
  name: "srv-x",
  version: "1.0",
  script: "srv-x",
  requires: ["helper-x==2.0"],
};
const helper = { name: "helper-x", version: "2.0", script: "helper-tool" };
const installs = (s) => path.join(s.dataDir, "mcp-packages", "installs");

test(
  "a wheel-only package installs into a relocatable venv and starts",
  { skip },
  async (t) => {
    const s = await pythonPackageService(t, [server, helper]);
    const { preview, server: ready } = await createPython(s, "srv-x");
    assert.deepEqual(preview.programs, ["srv-x"]);
    assert.equal(preview.needsScripts, false);
    assert.equal(preview.dependencyCount, 2);
    assert.match(preview.integrity, /^sha256:[0-9a-f]{64}$/);
    assert.equal(ready.source.status, "ready");
    assert.equal(ready.source.leadingArgs, 0);
    assert.match(
      ready.command,
      /mcp-packages\/installs\/[0-9a-f-]{36}\/venv\/bin\/srv-x$/,
    );
    assert.equal(
      execFileSync(ready.command, { env: { PATH: "/usr/bin:/bin" } })
        .toString()
        .trim(),
      "ok",
    );
    // Moved by the stage rename, and independent of the uv cache (UV_LINK_MODE=copy).
    assert.doesNotMatch(fs.readFileSync(ready.command, "utf8"), /\.stage-/);
    const site = path.dirname(path.dirname(ready.command));
    for (const name of fs.readdirSync(site, { recursive: true })) {
      const stat = fs.lstatSync(path.join(site, String(name)));
      if (stat.isFile()) assert.equal(stat.nlink, 1, String(name));
    }
  },
);

test("only the top distribution's scripts are programs", { skip }, async (t) => {
  const s = await pythonPackageService(t, [server, helper]);
  const preview = await s.packages.preview(pypiRef("srv-x"));
  assert.equal(preview.programs.includes("helper-tool"), false);
});

test(
  "an sdist-only package needs the opt-in and is refused without it",
  { skip },
  async (t) => {
    const s = await pythonPackageService(t, [
      { name: "old-x", version: "1.0", sdistOnly: true },
    ]);
    const preview = await s.packages.preview(pypiRef("old-x"));
    assert.equal(preview.needsScripts, true);
    assert.deepEqual(preview.programs, []);
    await assert.rejects(
      s.packages.createServer(
        { name: "old", transport: "stdio", source: pypiRef("old-x") },
        { previewId: preview.previewId },
      ),
      { code: "MCP_PACKAGE_NEEDS_SCRIPTS" },
    );
    assert.deepEqual(fs.existsSync(installs(s)) ? fs.readdirSync(installs(s)) : [], []);
  },
);

test(
  "an update shows the diff; reinstall uses the stored lock only",
  { skip },
  async (t) => {
    const s = await pythonPackageService(t, [
      server,
      helper,
      { ...helper, version: "3.0" },
      { ...server, version: "2.0", requires: ["helper-x==3.0"] },
    ]);
    const { server: ready } = await createPython(s, "srv-x");
    const update = await s.packages.preview({
      ...pypiRef("srv-x", "2.0"),
      serverId: ready.id,
    });
    assert.deepEqual(
      update.diff.changed.map((c) => [c.name, c.from, c.to]),
      [
        ["helper-x", "2.0", "3.0"],
        ["srv-x", "1.0", "2.0"],
      ],
    );
    fs.rmSync(installs(s), { recursive: true });
    assert.equal(s.servers.get(ready.id).source.status, "missing");
    s.packages.reinstall(ready.id);
    await s.packages.jobs.idle();
    assert.equal(s.servers.get(ready.id).source.status, "ready");
    assert.equal(s.servers.get(ready.id).source.version, "1.0");
  },
);
```

Run: `AGENTPIER_MCP_PYTHON_TESTS=1 node --test tests/integration/mcp-python-packages.test.js`
Expected: FAIL (`pypi` has no adapter). The first run downloads the real toolchain (~60 MB) into `$TMPDIR/agentpier-test-toolchains`.

- [ ] **Step 3: Implement the adapter**

```js
// server/features/mcp-packages/python-adapter.js
import fs from "node:fs";
import path from "node:path";
import { download as fetchDownload } from "../operations/releases.js";
import { packageProblem } from "./package-errors.js";
import { pythonCommand } from "./package-store.js";
import { installPython, resolvePython } from "./python-package-install.js";
import { checkPythonLock } from "./python-lock-check.js";
import { pypiProject, pypiVersionInfo, pypiVersions } from "./registry-metadata.js";
import { sha256Matches } from "./verified-files.js";
import {
  consoleScripts,
  installedEntryPoints,
  wheelEntryPoints,
} from "./wheel-programs.js";

export const pypiIndexRegistry = Object.freeze({
  api: "https://pypi.org",
  index: "https://pypi.org/simple",
});
const fileHost = "https://files.pythonhosted.org/";
const wheelLimit = 128 * 1024 * 1024;
const manifestText = (ref) => `${ref.name}==${ref.version}\n`;

/** The top release's wheel bytes, checked against PyPI's sha256. */
async function topWheel(info, { registry, download }) {
  const wheels = info.files.filter((f) => f.packagetype === "bdist_wheel");
  const wheel = wheels.find((f) => f.filename.endsWith("-py3-none-any.whl")) || wheels[0];
  if (!wheel) return null;
  if (registry.api === pypiIndexRegistry.api && !wheel.url?.startsWith(fileHost))
    throw packageProblem("MCP_PACKAGE_FOREIGN_SOURCE", 400);
  let bytes;
  try {
    bytes = await (download || ((url) => fetchDownload(url, fetch, wheelLimit)))(
      wheel.url,
    );
  } catch {
    throw packageProblem("MCP_PACKAGE_DOWNLOAD_FAILED", 502);
  }
  if (!sha256Matches(bytes, wheel.sha256))
    throw packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
  return { wheel, bytes };
}

/** PyPI behind the registry adapter interface (mcp-packages.js). */
export const pythonAdapter = {
  toolchainKind: "python",
  async versions(name, { registry, download }) {
    return pypiVersions(await pypiProject(name, { registry: registry.api, download }));
  },
  async preview({
    ref,
    allowScripts,
    toolchain,
    stage,
    registry,
    download,
    cacheDir,
    execute,
    environment,
  }) {
    const info = pypiVersionInfo(
      await pypiProject(ref.name, { registry: registry.api, download }),
      ref.version,
    );
    const digests = info.files.map((f) => f.sha256).filter(Boolean);
    const top = await topWheel(info, { registry, download });
    const python = await toolchain();
    let programs = [];
    if (top) {
      const file = path.join(stage, top.wheel.filename.replace(/[^A-Za-z0-9._-]/g, "_"));
      fs.writeFileSync(file, top.bytes, { mode: 0o600 });
      programs = consoleScripts(
        await wheelEntryPoints({ python, wheelFile: file, execute }),
      );
      if (!programs.length) throw packageProblem("MCP_PACKAGE_NO_PROGRAM", 400);
    }
    const resolved = await resolvePython({
      stage,
      ref,
      python,
      index: registry.index,
      cacheDir,
      allowScripts,
      execute,
      environment,
    });
    const checked = resolved.lockText
      ? checkPythonLock(resolved.lockText, { ref, digests })
      : { digest: null, dependencies: [] };
    return {
      integrity: `sha256:${top?.wheel.sha256 ?? digests[0]}`,
      programs,
      needsScripts: resolved.needsScripts,
      manifestText: resolved.requirementsText,
      lockText: resolved.lockText,
      digest: checked.digest,
      dependencies: checked.dependencies,
    };
  },
  checkStored({ lockText, ref }) {
    return checkPythonLock(lockText, { ref });
  },
  manifestText,
  install({
    directory,
    preview,
    toolchain,
    registry,
    cacheDir,
    execute,
    environment,
    log,
  }) {
    return installPython({
      directory,
      requirementsText: preview.manifestText,
      lockText: preview.lockText,
      python: toolchain,
      index: registry.index,
      cacheDir,
      allowScripts: preview.allowScripts,
      execute,
      environment,
      log,
    });
  },
  programsAfterInstall(directory, ref) {
    return consoleScripts(installedEntryPoints(path.join(directory, "venv"), ref.name));
  },
  command: (dataDir, receipt) => pythonCommand(dataDir, receipt),
  toolchainVersion: (toolchain) => toolchain.pythonVersion,
};
```

In `mcp-packages.js` import `pythonAdapter, pypiIndexRegistry`, add the constructor option `pypi = pypiIndexRegistry`, extend the `adapters` default with `pypi: pythonAdapter`, and set `this.registries = { npm: this.registry, pypi }`.

- [ ] **Step 4: Run the tests**

Run: `AGENTPIER_MCP_PYTHON_TESTS=1 node --test tests/integration/mcp-python-packages.test.js && node --test tests/integration/mcp-packages-service.test.js tests/unit/mcp-packages-service.test.js`
Expected: PASS (4 Python tests; npm suites unchanged). Without the variable the Python tests report as skipped.

- [ ] **Step 5: Run them in the native toolchain job**

In `.github/workflows/mcp-toolchains.yml` add after the verify step:

```yaml
- name: Python package installs against a local index
  env:
    AGENTPIER_MCP_PYTHON_TESTS: "1"
  run: node --test tests/integration/mcp-python-packages.test.js
```

and add to both `paths` lists:

```yaml
- "server/features/mcp-packages/python-*"
- "server/features/mcp-packages/wheel-programs.js"
- "server/features/mcp-packages/package-store.js"
- "tests/integration/mcp-python-packages.test.js"
- "tests/helpers/pypi-index-fixture.js"
- "tests/helpers/mcp-python-service.js"
```

Extend `tests/unit/mcp-toolchains-workflow.test.js`:

```js
test("the Python install tests run natively and trigger the workflow", () => {
  const python = steps.find((step) => step.run?.includes("mcp-python-packages.test.js"));
  assert.equal(python.env?.AGENTPIER_MCP_PYTHON_TESTS, "1");
  for (const event of ["push", "pull_request"])
    for (const file of [
      "server/features/mcp-packages/python-adapter.js",
      "server/features/mcp-packages/python-package-install.js",
      "server/features/mcp-packages/python-lock-check.js",
      "server/features/mcp-packages/wheel-programs.js",
      "tests/integration/mcp-python-packages.test.js",
      "tests/helpers/pypi-index-fixture.js",
    ])
      assert.ok(
        workflow.on[event].paths.some((pattern) => matches(pattern, file)),
        `${event}: ${file}`,
      );
});
```

Run: `node --test tests/unit/mcp-toolchains-workflow.test.js` → PASS.

- [ ] **Step 6: Commit**

```bash
git add server/features/mcp-packages tests/helpers/pypi-index-fixture.js tests/helpers/mcp-python-service.js \
  tests/integration/mcp-python-packages.test.js tests/unit/mcp-toolchains-workflow.test.js .github/workflows/mcp-toolchains.yml
git commit -m "feat: install PyPI MCP server packages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Source builds with the opt-in (real sdist, Linux CI)

Decision (minimal): source builds always run with `CC=cc` and `CXX=c++` (Task 5); no sysconfig rewrite of the toolchain. Preflight B12 shows this builds a setuptools C extension on Debian arm64 and amd64 with gcc and without clang; macOS `cc` is clang. Rust/maturin builds are not supported (no `cargo` on the minimal `PATH`), which the docs say.

**Files:**

- Modify: `tests/integration/mcp-python-packages.test.js`, `tests/helpers/mcp-python-service.js`

**Interfaces:**

- `pinnedSetuptools()` → path of `setuptools-84.0.0-py3-none-any.whl` in `sharedToolchains`, downloaded once from `https://files.pythonhosted.org/packages/95/9c/c510029fc6ef33a6275cd2c5d3cecd6613dfd6aa401d57c54f1c18852ccf/setuptools-84.0.0-py3-none-any.whl` and checked against sha256 `51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670` (the only network access besides the toolchain; the gated job already downloads the toolchain).

- [ ] **Step 1: Add the pinned build backend helper**

```js
// add to tests/helpers/mcp-python-service.js
import fs from "node:fs";
import { createHash } from "node:crypto";

const setuptools = {
  file: "setuptools-84.0.0-py3-none-any.whl",
  url: "https://files.pythonhosted.org/packages/95/9c/c510029fc6ef33a6275cd2c5d3cecd6613dfd6aa401d57c54f1c18852ccf/setuptools-84.0.0-py3-none-any.whl",
  sha256: "51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670",
};
/** The build backend sdists in the local index need, verified and cached. */
export async function pinnedSetuptools() {
  const file = path.join(sharedToolchains, setuptools.file);
  const ok = (bytes) =>
    createHash("sha256").update(bytes).digest("hex") === setuptools.sha256;
  if (fs.existsSync(file) && ok(fs.readFileSync(file))) return file;
  const bytes = Buffer.from(await (await fetch(setuptools.url)).arrayBuffer());
  if (!ok(bytes)) throw Error("setuptools checksum mismatch");
  fs.mkdirSync(sharedToolchains, { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}
```

- [ ] **Step 2: Write the failing test**

```js
// add to tests/integration/mcp-python-packages.test.js
import { pinnedSetuptools } from "../helpers/mcp-python-service.js";

test(
  "with the opt-in an sdist with a C extension builds with cc and starts",
  { skip },
  async (t) => {
    const s = await pythonPackageService(t, [
      { name: "old-c", version: "1.0", script: "old-c", sdist: "c-extension" },
      { name: "setuptools", version: "84.0.0", file: await pinnedSetuptools() },
    ]);
    const refused = await s.packages.preview(pypiRef("old-c"));
    assert.equal(refused.needsScripts, true);
    const { preview, server: ready } = await createPython(s, "old-c", {
      allowScripts: true,
    });
    assert.equal(preview.needsScripts, true);
    assert.deepEqual(preview.programs, []);
    assert.equal(ready.source.status, "ready", s.packages.jobs.get(ready.id)?.log);
    assert.equal(ready.source.program, "old-c");
    assert.equal(
      execFileSync(ready.command, { env: { PATH: "/usr/bin:/bin" } })
        .toString()
        .trim(),
      "built",
    );
  },
);
```

Run: `AGENTPIER_MCP_PYTHON_TESTS=1 node --test --test-name-pattern "C extension" tests/integration/mcp-python-packages.test.js`
Expected before Steps 1–2 are wired: FAIL; after: PASS on macOS with the command line tools and on the Linux runners (the CI step from Task 6 runs it on linux-x64 and linux-arm64 for pull requests, on all four targets otherwise). If the Linux run fails with `clang` not found, `CC` did not reach the build backend: check `uvEnvironment`, do not add per-host workarounds.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/mcp-python-packages.test.js tests/helpers/mcp-python-service.js
git commit -m "test: build a Python C extension from source with the opt-in

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Dependency constraints for PyPI sources (owner decision D4)

The owner can pin transitive dependencies of a PyPI package with up to 10 PEP 508 constraint lines such as `fastmcp<4`. They narrow the resolve only (`uv pip compile -c constraints.txt`); the result is still one hashed lock, so reinstall never resolves again, and an update keeps the stored constraints unless the owner edits them. npm sources take none (the owner asked for PyPI only; the docs say so).

**Files:**

- Modify: `server/features/mcp-packages/package-spec.js` (`packageConstraints`)
- Modify: `server/lib/i18n/de/mcp-packages.js`, `server/lib/i18n/en/mcp-packages.js` (`invalidConstraints`)
- Modify: `server/features/mcp-packages/package-records.js` (column `constraints`, migration, public fields)
- Modify: `server/features/operations/mcp-server-backup.js` (`knownColumns.server_packages` gains `constraints`)
- Modify: `server/features/mcp-packages/python-package-install.js`, `python-adapter.js`, `npm-adapter.js`, `mcp-packages.js`, `package-install-job.js`
- Modify: `server/http/routes/mcp-packages.js` (`auditDetails` gains `constraints`)
- Test: extend `tests/unit/mcp-package-spec.test.js`, `tests/unit/mcp-package-records.test.js`, `tests/unit/mcp-python-install.test.js`, `tests/integration/mcp-server-host-backups.test.js`, `tests/integration/mcp-python-packages.test.js`

**Interfaces:**

- `packageConstraints(input, ref)` → canonical lines (`normalizePypiName(name)` + specifiers without spaces, for example `FastMCP >= 3, < 4` → `fastmcp>=3,<4`). Accepted per line: a PyPI name and one or more comma-separated clauses `==`/`!=` (optionally `.*`), `~=`, `<=`, `>=`, `<`, `>` with a PEP 440 version. Refused with `400 MCP_PACKAGE_INVALID` (message key `invalidConstraints`): anything else (URLs, paths, `@`, extras, markers, `;`, options such as `-e`/`--index-url`/`--hash`, `===`), the top package itself, a name twice, more than 10 lines, a line over 100 characters, a non-array, and any constraint on an npm source.
- Records: column `constraints TEXT NOT NULL DEFAULT '[]'` (JSON array); `PackageRecords` adds it to existing stores with `ALTER TABLE` and reads a missing or invalid value as `[]`; `publicFields().source.constraints`.
- `resolvePython({ …, constraints = [] })` writes `constraints.txt` in its work folder and passes `-c <file>` to both compiles; compiles also pass `--no-annotate` (Task 5), so the file path never reaches the lock.
- Adapter `preview({ …, constraints })`; npm ignores it (always `[]`).
- `McpPackages.preview(input)` reads `input.constraints`; for an update preview (`serverId`) without `constraints` the stored ones apply. The preview response and the stored preview carry `constraints`; `takePreview` refuses (`MCP_PACKAGE_PREVIEW_EXPIRED`) when the confirmed source's constraints differ. `updatePackage(id, { constraints, … })` defaults to `row.constraints`. `sourceFields` stores `constraints`. `reinstall` keeps the record's constraints and never resolves.

- [ ] **Step 1: Write the failing unit tests**

```js
// add to tests/unit/mcp-package-spec.test.js
import { packageConstraints } from "../../server/features/mcp-packages/package-spec.js";

const top = { registry: "pypi", name: "opnsense-mcp-server", version: "0.4.1" };
test("PyPI constraints are a name with version limits only (D4)", () => {
  assert.deepEqual(packageConstraints({}, top), []);
  assert.deepEqual(
    packageConstraints(
      { constraints: ["fastmcp<4", " FastMCP_Slim >= 3.0 , < 4 ", "httpx==0.28.*"] },
      top,
    ),
    ["fastmcp<4", "fastmcp-slim>=3.0,<4", "httpx==0.28.*"],
  );
  for (const line of [
    "fastmcp",
    "fastmcp[cli]<4",
    "x @ https://example.com/x.whl",
    "-e git+https://github.com/a/b.git",
    "--index-url https://example.com/simple",
    "x<4 ; python_version < '3.12'",
    "x<4 --hash=sha256:aa",
    "../x<1",
    "x~=1.*",
    "x===1",
    "x<4\ny<2",
    "opnsense-mcp-server<1",
    `x<${"1".repeat(100)}`,
  ])
    assert.throws(
      () => packageConstraints({ constraints: [line] }, top),
      { code: "MCP_PACKAGE_INVALID" },
      line,
    );
  assert.throws(() => packageConstraints({ constraints: ["a<1", "A<2"] }, top), {
    code: "MCP_PACKAGE_INVALID",
  });
  assert.throws(
    () =>
      packageConstraints(
        { constraints: Array.from({ length: 11 }, (_, i) => `p${i}<1`) },
        top,
      ),
    { code: "MCP_PACKAGE_INVALID" },
  );
  assert.throws(() => packageConstraints({ constraints: "fastmcp<4" }, top), {
    code: "MCP_PACKAGE_INVALID",
  });
  const npm = { registry: "npm", name: "x", version: "1.0.0" };
  assert.deepEqual(packageConstraints({ constraints: [] }, npm), []);
  assert.throws(() => packageConstraints({ constraints: ["y<1"] }, npm), {
    code: "MCP_PACKAGE_INVALID",
  });
});
```

```js
// add to tests/unit/mcp-package-records.test.js
import { DatabaseSync } from "node:sqlite";
import { PackageRecords } from "../../server/features/mcp-packages/package-records.js";

test("constraints are stored as a list and shown with the source", (t) => {
  const { servers } = store(t);
  const server = pending(servers, {}, { registry: "pypi", constraints: ["fastmcp<4"] });
  assert.deepEqual(servers.packages.get(server.id).constraints, ["fastmcp<4"]);
  assert.deepEqual(servers.get(server.id).source.constraints, ["fastmcp<4"]);
});

test("a store from before constraints gains the column; old rows read []", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE servers(id TEXT PRIMARY KEY)");
  db.exec(`CREATE TABLE server_packages(
    server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    registry TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL,
    program TEXT NOT NULL, program_path TEXT NOT NULL, allow_scripts INTEGER NOT NULL DEFAULT 0,
    lock TEXT NOT NULL, lock_digest TEXT NOT NULL, integrity TEXT NOT NULL,
    install_id TEXT, leading_args INTEGER NOT NULL DEFAULT 0, toolchain_dir TEXT,
    status TEXT NOT NULL CHECK(status IN ('installing','ready','failed')),
    error_code TEXT, updated_at INTEGER NOT NULL)`);
  db.exec("INSERT INTO servers VALUES ('s1')");
  db.exec(
    "INSERT INTO server_packages VALUES ('s1','npm','x','1.0.0','x','i.js',0,'{}','d','i',NULL,0,NULL,'installing',NULL,1)",
  );
  const records = new PackageRecords(db, "/unused");
  assert.deepEqual(records.get("s1").constraints, []);
});
```

Also add `constraints: []` to the exact `source` expectation of "a pending packaged server has no command, shows its args and is not compiled", and to every other test that compares a whole `source` (`grep -rn "leadingArgs: 0" tests/` finds them).

```js
// add to tests/unit/mcp-python-install.test.js
test("constraints narrow both compiles through a constraints file", async (t) => {
  const calls = [];
  const execute = async (file, args) => {
    const at = args.indexOf("-c");
    calls.push(fs.readFileSync(args[at + 1], "utf8"));
    assert.ok(args.includes("--no-annotate"));
    fs.writeFileSync(
      args[args.indexOf("-o") + 1],
      "srv-x==1.0 \\\n    --hash=sha256:x\n",
    );
    return { stdout: "", stderr: "" };
  };
  await resolvePython({
    stage: tmp(t),
    ref,
    python,
    index: "http://i/simple",
    cacheDir: tmp(t),
    allowScripts: false,
    constraints: ["fastmcp<4", "httpx==0.28.*"],
    execute,
    environment: {},
  });
  assert.deepEqual(calls, ["fastmcp<4\nhttpx==0.28.*\n"]);
});
```

Run: `node --test tests/unit/mcp-package-spec.test.js tests/unit/mcp-package-records.test.js tests/unit/mcp-python-install.test.js`
Expected: FAIL (`packageConstraints` missing, no column, no `-c`).

- [ ] **Step 2: Implement validation and copy**

In `package-spec.js`:

```js
const pep440 = String.raw`\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?`;
const clause = String.raw`(?:(?:==|!=)\s*${pep440}(?:\.\*)?|(?:~=|<=|>=|<|>)\s*${pep440})`;
// A PyPI name and version limits, nothing else: no URL, path, extra, marker or option.
const constraintLine = new RegExp(
  String.raw`^([A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?)\s*(${clause}(?:\s*,\s*${clause})*)$`,
  "i",
);
export const constraintLimits = Object.freeze({ count: 10, length: 100 });
const invalidConstraints = () =>
  packageProblem("MCP_PACKAGE_INVALID", 400, "invalidConstraints");

/** The owner's dependency constraints of a PyPI source (D4), canonical; npm has none. */
export function packageConstraints(input = {}, ref) {
  const lines = input.constraints ?? [];
  if (!Array.isArray(lines)) throw invalidConstraints();
  if (ref.registry !== "pypi") {
    if (lines.length) throw invalidConstraints();
    return [];
  }
  if (lines.length > constraintLimits.count) throw invalidConstraints();
  const names = new Set();
  return lines.map((line) => {
    if (typeof line !== "string" || line.length > constraintLimits.length)
      throw invalidConstraints();
    const match = constraintLine.exec(line.trim());
    if (!match) throw invalidConstraints();
    const name = normalizePypiName(match[1]);
    if (name === ref.name || names.has(name)) throw invalidConstraints();
    names.add(name);
    return `${name}${match[2].replace(/\s+/g, "")}`;
  });
}
```

Server copy — en: `invalidConstraints: "Dependency constraints take one PyPI package name with version limits per line (for example fastmcp<4), at most 10.",`; de: `invalidConstraints: "Abhängigkeitsgrenzen bestehen aus einem PyPI-Paketnamen mit Versionsgrenzen pro Zeile (zum Beispiel fastmcp<4), höchstens 10.",`.

- [ ] **Step 3: Store them**

`package-records.js`: add `constraints TEXT NOT NULL DEFAULT '[]'` to the schema and `constraints: "constraints"` to `columns`; in the constructor after `db.exec(schema)`:

```js
const known = db.prepare("PRAGMA table_info(server_packages)").all();
if (!known.some((column) => column.name === "constraints"))
  db.exec(
    "ALTER TABLE server_packages ADD COLUMN constraints TEXT NOT NULL DEFAULT '[]'",
  );
```

`fromRow` sets `constraints: parsedList(row.constraints)` (`JSON.parse` in `try`, an array of strings or `[]`); `toValue` writes `JSON.stringify(value ?? [])` for `constraints`; `publicFields` adds `constraints: row.constraints`. `mcp-server-backup.js`: append `"constraints"` to `knownColumns.server_packages` (constraints are not secret; without this the sanitizer drops the column from backups). Extend the backup test in `tests/integration/mcp-server-host-backups.test.js` to put a record with `constraints: ["fastmcp<4"]` and assert `SELECT constraints FROM server_packages` in the copy is `'["fastmcp<4"]'`.

- [ ] **Step 4: Resolve with them**

`python-package-install.js` — `resolvePython` gains `constraints = []`; after writing `requirements.in`:

```js
const constraintArgs = [];
if (constraints.length) {
  const file = path.join(work, "constraints.txt");
  fs.writeFileSync(file, `${constraints.join("\n")}\n`, { mode: 0o600 });
  constraintArgs.push("-c", file);
}
```

and `compile` appends `...constraintArgs` before `...extra`. `python-adapter.js` passes `constraints` from its `preview` arguments to `resolvePython`; `npm-adapter.js` accepts and ignores it.

`mcp-packages.js`:

```js
async preview(input) {
  const ref = packageRef(input);
  const current = input.serverId ? this.records.get(input.serverId) : null;
  // An update keeps the stored constraints unless the owner sends new ones.
  const constraints = packageConstraints(
    input.constraints === undefined && current ? { constraints: current.constraints } : input,
    ref,
  );
  try {
    return await this.resolvePreview(ref, input, constraints, current);
  } catch (error) {
    throw packageError(error, "MCP_PACKAGE_INSTALL_FAILED", 502);
  }
}
```

`resolvePreview(ref, input, constraints, current)` passes `constraints` to `adapter.preview`, stores it in the preview, returns it in the response (`constraints`), and uses the given `current` for the diff. `takePreview(previewId, source)` additionally refuses when `JSON.stringify(preview.constraints) !== JSON.stringify(packageConstraints(source, ref))`. `updatePackage(id, { version, allowScripts, constraints, previewId, program })` builds the source with `constraints: constraints ?? row.constraints`. `reinstall` puts `constraints: row.constraints` into its preview object. `package-install-job.js` `sourceFields` adds `constraints: preview.constraints ?? []`; the receipt adds `constraints` too. `routes/mcp-packages.js` `auditDetails` adds `constraints: Array.isArray(source?.constraints) ? source.constraints : []` (no secrets; an audit names what was pinned).

- [ ] **Step 5: Integration test against the local index**

```js
// add to tests/integration/mcp-python-packages.test.js
test(
  "a constraint narrows the resolve and stays for reinstall and update",
  { skip },
  async (t) => {
    const s = await pythonPackageService(t, [
      { name: "srv-y", version: "1.0", script: "srv-y", requires: ["helper-x>=2"] },
      { name: "srv-y", version: "1.1", script: "srv-y", requires: ["helper-x>=2"] },
      helper,
      { ...helper, version: "3.0" },
    ]);
    const free = await s.packages.preview(pypiRef("srv-y"));
    assert.ok(
      free.dependencies.some((d) => d.name === "helper-x" && d.version === "3.0"),
    );
    const { preview, server: ready } = await createPython(s, "srv-y", {
      constraints: ["Helper_X < 3"],
    });
    assert.deepEqual(preview.constraints, ["helper-x<3"]);
    assert.ok(
      preview.dependencies.some((d) => d.name === "helper-x" && d.version === "2.0"),
    );
    assert.deepEqual(ready.source.constraints, ["helper-x<3"]);
    fs.rmSync(installs(s), { recursive: true });
    s.packages.reinstall(ready.id);
    await s.packages.jobs.idle();
    assert.equal(s.servers.get(ready.id).source.status, "ready");
    const update = await s.packages.preview({
      ...pypiRef("srv-y", "1.1"),
      serverId: ready.id,
    });
    assert.deepEqual(update.constraints, ["helper-x<3"]);
    assert.deepEqual(
      update.diff.changed.map((c) => c.name),
      ["srv-y"],
    );
    await assert.rejects(
      s.packages.preview({
        ...pypiRef("srv-y"),
        constraints: ["helper-x @ http://e/x.whl"],
      }),
      { code: "MCP_PACKAGE_INVALID" },
    );
  },
);
```

The fixture already serves two releases per project (`releases[version]`); `createPython` spreads `constraints` into both preview and source. Note `"Helper_X < 3"` checks the canonical form end to end.

- [ ] **Step 6: Run and commit**

Run: `node --test tests/unit/mcp-package-spec.test.js tests/unit/mcp-package-records.test.js tests/unit/mcp-python-install.test.js tests/unit/mcp-packages-service.test.js tests/integration/mcp-server-host-backups.test.js tests/integration/mcp-packages-routes.test.js tests/integration/mcp-packages-service.test.js tests/unit/server-i18n-catalogs.test.js && AGENTPIER_MCP_PYTHON_TESTS=1 node --test tests/integration/mcp-python-packages.test.js`
Expected: PASS; every touched file stays below 600 lines.

```bash
git add server tests/unit tests/integration
git commit -m "feat: pin dependencies of PyPI MCP packages with constraints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: PyPI and constraints in the form

**Files:**

- Modify: `web/lib/i18n/de/mcp-packages.js`, `web/lib/i18n/en/mcp-packages.js`
- Modify: `web/features/mcp-servers/McpPackageFields.jsx`, `McpPackageConfirmation.jsx`, `McpPackagePanel.jsx`, `mcp-server-draft.js`, `mcp-server-save.js`
- Modify: `tests/browser/mcp-packages-fixture.js` (export `pypiVersions`), `tests/browser/mcp-packages.spec.js`

- [ ] **Step 1: Copy (both catalogs, same keys)**

English:

- `registries: { npm: "npm", pypi: "PyPI" }`, `yanked: "withdrawn by its author"`, `noProgramsYet: "The program is chosen after the build."`
- `allowScriptsWarning: "Package code then runs while the package is checked and installed, with your user's rights. Allow it only for packages you trust."`
- `buildToolsNote: "Build tools such as setuptools are then downloaded from PyPI during the build; they are not part of the frozen, hash-checked dependency list."`
- `constraintsLabel: "Dependency constraints"`, `constraintsHint: "Optional. One PyPI package with version limits per line, for example fastmcp<4. They apply when the package is resolved; reinstalling uses the frozen list."`, `constraintsTitle: "Constraints"`

German:

- `registries: { npm: "npm", pypi: "PyPI" }`, `yanked: "vom Autor zurückgezogen"`, `noProgramsYet: "Das Programm wird nach dem Build gewählt."`
- `allowScriptsWarning: "Paketcode läuft dann schon beim Prüfen und beim Installieren mit den Rechten deines Benutzers. Erlaube das nur für Pakete, denen du vertraust."` (keep the catalog's existing form of address if it differs)
- `buildToolsNote: "Build-Werkzeuge wie setuptools werden dann während des Builds von PyPI geladen; sie gehören nicht zur eingefrorenen, per Prüfsumme gesicherten Abhängigkeitsliste."`
- `constraintsLabel: "Abhängigkeitsgrenzen"`, `constraintsHint: "Optional. Ein PyPI-Paket mit Versionsgrenzen pro Zeile, zum Beispiel fastmcp<4. Sie gelten beim Auflösen; eine Neuinstallation nutzt die eingefrorene Liste."`, `constraintsTitle: "Grenzen"`

- [ ] **Step 2: Failing browser tests**

```js
// tests/browser/mcp-packages-fixture.js
export const pypiVersions = {
  latest: "0.4.1",
  versions: [
    {
      version: "0.4.1",
      publishedAt: "2026-08-19T00:00:00Z",
      prerelease: false,
      deprecated: false,
      yanked: false,
    },
    {
      version: "0.4.0",
      publishedAt: "2026-07-01T00:00:00Z",
      prerelease: false,
      deprecated: false,
      yanked: true,
    },
  ],
};
```

```js
// add to tests/browser/mcp-packages.spec.js (import pypiVersions)
test("a PyPI package shows withdrawn versions and installs with a constraint", async ({
  page,
}) => {
  const state = await packageSetup(page);
  state.versions = pypiVersions;
  state.preview = preview({
    registry: "pypi",
    name: "opnsense-mcp-server",
    version: "0.4.1",
    integrity: "sha256:85540ca61ed3cc27731471c45e1c74fb0a888827fb145bc58ce3a2104d243d19",
    programs: ["opnsense-mcp"],
    constraints: ["fastmcp<4"],
  });
  acceptCreate(state);
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await dialog.getByLabel("Name", { exact: true }).fill("opnsense");
  await choosePackage(dialog);
  await expect(dialog.getByLabel("Dependency constraints")).toHaveCount(0);
  await dialog.getByRole("radio", { name: "PyPI" }).check();
  await dialog.getByLabel("Package", { exact: true }).fill("opnsense-mcp-server");
  const version = dialog.getByLabel("Version", { exact: true });
  await expect(version).toHaveValue("0.4.1");
  await expect(version.locator("option").nth(1)).toContainText("withdrawn by its author");
  await dialog.getByLabel("Dependency constraints").fill("fastmcp<4\n\n");
  await dialog.getByRole("button", { name: "Save server" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Install this package?" });
  await expect(confirm.getByText("PyPI")).toBeVisible();
  await expect(confirm.getByText("fastmcp<4")).toBeVisible();
  expect(state.requests.find((r) => r.path.endsWith("/preview")).body).toMatchObject({
    registry: "pypi",
    constraints: ["fastmcp<4"],
  });
  await confirm.getByRole("button", { name: "Install" }).click();
  expect(writes(state, "/api/mcp-servers")[0].body.source).toMatchObject({
    registry: "pypi",
    name: "opnsense-mcp-server",
    version: "0.4.1",
    constraints: ["fastmcp<4"],
  });
});

test("a package that is built first names its program and the build tools", async ({
  page,
}) => {
  const state = await packageSetup(page);
  state.preview = preview({ registry: "pypi", programs: [], needsScripts: true });
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await dialog.getByLabel("Name", { exact: true }).fill("old");
  await choosePackage(dialog);
  await dialog.getByRole("radio", { name: "PyPI" }).check();
  await dialog.getByLabel("Package", { exact: true }).fill("old-x");
  await dialog.getByLabel("Allow install scripts or source builds").check();
  await dialog.getByRole("button", { name: "Save server" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Install this package?" });
  await expect(confirm.getByText("The program is chosen after the build.")).toBeVisible();
  await expect(confirm.getByText(/Build tools such as setuptools/)).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Install" })).toBeEnabled();
});
```

Extend the German test ("German: the form offers the package source") with `await dialog.getByRole("radio", { name: "PyPI" }).check();` and `await expect(dialog.getByLabel("Abhängigkeitsgrenzen")).toBeVisible();`. For the status panel, add to the update test's packaged server `source: { …, registry: "pypi", constraints: ["fastmcp<4"] }` in a new short test that asserts the panel shows `fastmcp<4` and that **Check update** sends `constraints: ["fastmcp<4"]` unless the field is edited.

Run: `npm run build && npx playwright test tests/browser/mcp-packages.spec.js` → FAIL.

- [ ] **Step 3: Implement**

- `McpPackageFields.jsx`: registry `Segment` options `["npm", "pypi"]`; switching the registry clears the version; the name placeholder is `values.registry === "pypi" ? "mcp-server-name" : "@scope/server"` (identifiers, not copy); `optionLabel` adds `entry.yanked && copy.yanked`. Export `McpConstraints({ id, value, onChange })` (a `<textarea>` labelled `copy.constraintsLabel` with `copy.constraintsHint` as description, `spellCheck={false}`, `autoCapitalize="none"`) and `constraintLines(text)` (`text.split("\n").map((l) => l.trim()).filter(Boolean)`); render `McpConstraints` only when `values.registry === "pypi"`.
- `mcp-server-draft.js`: `packageConstraints: (server?.source?.constraints || []).join("\n")`.
- `mcp-server-save.js`: `previewPackage` and the saved `source` (in `requestBody`) carry `constraints: values.registry === "pypi" ? constraintLines(values.packageConstraints) : []`.
- `McpPackageConfirmation.jsx`: when `preview.constraints?.length`, a `<dt>{copy.constraintsTitle}</dt><dd>` with the lines; when `programs.length === 0` show `copy.noProgramsYet`; when `allowScripts && preview.registry === "pypi"` append `copy.buildToolsNote` to the scripts warning.
- `McpPackagePanel.jsx`: show the stored constraints under the heading for PyPI sources; the update area holds `McpConstraints` prefilled with them; `checkUpdate` and `confirmUpdate` send `constraints: constraintLines(text)`; `unchanged` also compares the constraint lines.

Run: `npm run build && npx playwright test tests/browser/mcp-packages.spec.js && node --test tests/unit/i18n-*.test.js tests/unit/server-i18n-catalogs.test.js` → PASS. `wc -l tests/browser/mcp-packages.spec.js web/features/mcp-servers/McpPackage*.jsx` stays below 600. Exercise the form once in English in a browser and once in German.

- [ ] **Step 4: Commit**

```bash
git add web tests/browser/mcp-packages.spec.js tests/browser/mcp-packages-fixture.js
git commit -m "feat: offer PyPI and dependency constraints in the MCP package form

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Review the OPNsense server before installing it

**Files:**

- Create: `docs/mcp-package-qualification.md` (first section)

Facts from the preflight (2026-10-15, preflight C1–C10), to verify again, not to copy blindly: PyPI `opnsense-mcp-server` 0.4.1, `requires_python >=3.11`, source `https://github.com/lucamarien/opnsense-mcp-server`, wheel `opnsense_mcp_server-0.4.1-py3-none-any.whl` sha256 `85540ca61ed3cc27731471c45e1c74fb0a888827fb145bc58ce3a2104d243d19`, program `opnsense-mcp`, writes gated by `OPNSENSE_ALLOW_WRITES` (default false). **Known blocker (C10):** 0.4.1 requires only `fastmcp>=2.0`; fastmcp 4.1.0 depends on `httpx2`, so no `httpx` distribution is installed while `opnsense_mcp/api_client.py:11` imports `httpx` — the server cannot start from an unconstrained resolve. **Working range (checked 2026-10-15 by resolving and inspecting installed files, no package code run):** fastmcp `>=3.0.0,<4`. With the constraint `fastmcp<4` the resolve picks fastmcp 3.4.8 with `httpx` 0.28.1 and `mcp` 1.30.0, and `fastmcp/server/lifespan.py` (`lifespan`), `Context.lifespan_context` and `FastMCP(version=, lifespan=)` exist; fastmcp 2.x (`fastmcp<3` → 2.14.7) has `httpx` but no `fastmcp.server.lifespan`, so the import fails there too. 3.0.0, 3.1.0 and 3.2.0 wheels also ship `lifespan.py` and require `httpx>=0.28.1,<1.0`.

- [ ] **Step 1: Download and inspect the exact release without running it**

Work in a new empty directory outside the repository; scripts that read the download live elsewhere; Python runs with `-I`.

```bash
D=$(mktemp -d) && mkdir "$D/dl" "$D/src" && cd "$D"
curl -sSL https://pypi.org/pypi/opnsense-mcp-server/json -o meta.json
python3 -I -c "import json;d=json.load(open('meta.json'));print(d['info']['version']);[print(f['filename'],f['digests']['sha256'],f['url']) for f in d['urls']]"
curl -sSL -o dl/w.whl "<wheel url printed above>" && shasum -a 256 dl/w.whl
python3 -I -m zipfile -e dl/w.whl src
cat src/*.dist-info/entry_points.txt; grep '^Requires-Dist' src/*.dist-info/METADATA
grep -n -E "ALLOW_WRITES|require_writes|BLOCKED_ENDPOINTS|def post|import httpx" -r src/opnsense_mcp
```

Then list every `.post(` call site with its function and whether that function calls `require_writes()` or `SavepointManager.create()` before the first POST (an `ast` walk over `src/opnsense_mcp`, run with `python3 -I` from a script outside `$D`). Expected: (a) the write switch and its default, (b) the non-GET call sites and their gate, (c) the blocklist, (d) the ungated POSTs (search endpoints, `opn_ping`, `opn_traceroute`, `opn_dns_lookup`), (e) `opn_download_config(include_sensitive=True)`, (f) whether the newest release still imports `httpx` without depending on it, and (g) the fastmcp range that provides every name `opnsense_mcp` imports from `fastmcp` (resolve with `-c` and read the installed files; do not run the server). If a newer release than 0.4.1 exists, review that one instead and note it.

- [ ] **Step 2: Write the findings**

`docs/mcp-package-qualification.md`:

```markdown
# MCP package qualification

Managed MCP server packages (see [MCP](mcp.md#installing-a-server-package)) were
qualified on <date> on <platform>, AgentPier <commit>, toolchains Node 26.7.0,
uv 0.12.21 and CPython 3.14.7.

## OPNsense server review (opnsense-mcp-server <version>)

- Wheel `<filename>`, SHA-256 `<hash>` (matches PyPI); program `opnsense-mcp`.
- Write switch: `OPNSENSE_ALLOW_WRITES`, default `false` (`opnsense_mcp/config.py:<line>`).
- Gate: `OPNsenseAPI.require_writes()` (`api_client.py:<line>`); every
  configuration change calls it directly or through `SavepointManager.create()` before
  its first POST (<n> call sites checked).
- POSTs without the gate: OPNsense search endpoints (reads) and the diagnostics tools
  `opn_ping`, `opn_traceroute`, `opn_dns_lookup`, which start short diagnostic jobs.
- Blocked endpoints: `<list>` (`api_client.py:<line>`).
- `opn_download_config` with `include_sensitive=true` returns the configuration
  unredacted: the API user gets no backup privilege.
- Dependencies: `<Requires-Dist>`; `<httpx finding>`; installs with the dependency
  constraint `fastmcp<4` (working range `<range>`).
- Verdict: <read-only by default in code: yes/no>; the enforced boundary is the
  restricted API user (status and diagnostics read privileges only).
```

Fill every `<…>` from Step 1. If writes are reachable without the opt-in, stop: report to the owner and do not install it for the agent.

- [ ] **Step 3: Commit**

```bash
git add docs/mcp-package-qualification.md
git commit -m "docs: record the OPNsense MCP server review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Manual qualification with real servers (owner present)

**Files:**

- Modify: `docs/mcp-package-qualification.md`

**Owner input, asked at the start of this task in the conversation (in German):**

1. Which agent is the network architect (or permission to create one in the disposable instance).
2. The OPNsense details. Ask the owner to type the API key and secret **themselves** into the server's **Environment** fields in the disposable AgentPier form (`OPNSENSE_URL`, `OPNSENSE_API_KEY`, `OPNSENSE_API_SECRET`, `OPNSENSE_VERIFY_SSL=true`); AgentPier stores them in its secret storage (`server_secrets`). Never ask for the key or secret in the chat. If the owner pastes them anyway, do not repeat them, do not write them to any file, log, shell history, commit or this document, and only enter them through the form. The API user must be a dedicated user/group with status and diagnostics read privileges only (no backup, no firmware, no write privileges).
3. If OPNsense uses a private CA: the path of its CA certificate (public data). Set `SSL_CERT_FILE=<path>` in the server's environment; with nono the file must lie inside a granted directory (copy it into the disposable data directory).
4. Nothing to decide for the OPNsense blocker: the owner chose dependency constraints (D4). The server is installed as `opnsense-mcp-server` 0.4.1 with the constraint `fastmcp<4` and the program `opnsense-mcp` (Task 10 confirms the range). Do not patch the package or its environment by hand.
5. `pandoc` for the `mcp-pandoc` row: the owner installs the CLI before the qualification. Check `command -v pandoc` (and `pandoc --version`) first; if it is missing, stop and ask the owner through the controller to install it, then continue. If the server cannot find it on its own `PATH`, set `PYPANDOC_PANDOC=<absolute path of pandoc>` in the server's environment (pypandoc reads it).
6. Signing in a Claude Code account in the disposable instance, if Claude Code bindings need one.

**Steps:**

- [ ] **Step 1: Run a disposable AgentPier** (never the owner's instance on port 4380)

```bash
npm run build
export AGENTPIER_DATA_DIR=$(mktemp -d) AGENTPIER_PORT=4391
npm start
```

Use a disposable Claude Code profile inside that data directory (`docs/mcp.md` "Verification limits"); never the owner's real `~/.claude.json`.

- [ ] **Step 2: Install, bind and call each server**

For each row: create the server from the form (latest stable version unless noted), wait for **Installed**, bind it to one agent and to Claude Code, and make one real tool call from each.

| Server                                                                      | Registry                                         | Arguments / env                                                             | Tool call                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------- |
| `@modelcontextprotocol/server-memory`                                       | npm                                              | —                                                                           | create an entity, read it back                        |
| `@modelcontextprotocol/server-filesystem`                                   | npm                                              | an allowed directory (inside the disposable data dir)                       | list the directory                                    |
| `mcp-server-time` (2026.10.10 on 2026-10-15)                                | PyPI                                             | —                                                                           | current time in Europe/Berlin                         |
| `mcp-server-fetch` (2026.10.10)                                             | PyPI                                             | —                                                                           | fetch `https://example.com`                           |
| `opnsense-mcp-server` 0.4.1, constraint `fastmcp<4`, program `opnsense-mcp` | PyPI                                             | owner's environment values, see above; bound to the network architect agent | list interfaces or gateway status                     |
| `mcp-pandoc` (0.11.1; dependency `pandoc==2.4` is sdist-only)               | PyPI, **Allow install scripts or source builds** | —                                                                           | `convert-contents`: a real Markdown → HTML conversion |

For the opt-in row, first confirm that without the opt-in the confirmation shows the needs-scripts notice and **Install** stays disabled, and with it the build-tools note. For OPNsense confirm that the confirmation and the status panel list `fastmcp<4` and that the installed graph holds fastmcp 3.x and `httpx`. For OPNsense also confirm that a write tool (for example `opn_add_alias` with a dummy name) answers "Write operations disabled" and that nothing changed on the firewall.

Also check: update one server to an older/newer version and see the diff; delete its install directory and use **Reinstall**; remove a server and confirm `mcp-packages/installs/` no longer holds its directory.

- [ ] **Step 3: Draft the upstream issue (never post it without approval)**

Write the draft into the session (not into the repository) and then **stop and ask the controller** for approval before anything is posted to GitHub or anywhere else; post only the approved text, with the owner's account, and record the issue link in the qualification document.

```markdown
Title: opnsense-mcp-server fails to start with fastmcp 4.x (`import httpx`, httpx2 only)

`opnsense-mcp-server` 0.4.1 declares `fastmcp>=2.0`. Since fastmcp 4.x
(4.1.0, 2026-10-08) depends on `httpx2` instead of `httpx`, a fresh install
(`pip install opnsense-mcp-server==0.4.1` or `uvx opnsense-mcp-server`) resolves
fastmcp 4.1.0 and no `httpx` distribution, while `opnsense_mcp/api_client.py`
imports `httpx`, so the server cannot start. fastmcp 2.x lacks
`fastmcp.server.lifespan`, which `server.py` imports.

Pinning `fastmcp>=3,<4` (resolves fastmcp 3.4.8 and httpx 0.28.1) works.
Suggested fix: declare `httpx` as a direct dependency and bound fastmcp to the
supported major version (`fastmcp>=3,<4`) until 4.x is supported.
```

- [ ] **Step 4: Record results**

Append to `docs/mcp-package-qualification.md` a table: server, version, registry, install time, agent call result, Claude Code call result, notes; plus the update/reinstall/remove checks, the OPNsense constraint (`fastmcp<4`, resolved fastmcp version), the upstream issue link (or "not posted") and the build-tools note (setuptools came from PyPI at build time, outside the lock, D5). Linux results come from the `mcp-toolchains` workflow (toolchains, local-index installs and the C-extension build); state that real-server calls ran on macOS only unless the owner provides a Linux host. No credential, host name of the firewall or API user name goes into the document.

- [ ] **Step 5: Stop the instance, delete the disposable data directory, commit**

```bash
rm -rf "$AGENTPIER_DATA_DIR"
git add docs/mcp-package-qualification.md
git commit -m "docs: record the MCP package qualification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Docs, full check and cleanup

**Files:**

- Modify: `docs/mcp.md` ("Installing a server package")
- Modify: `docs/AGENTS.md` (MCP servers bullet)
- Delete: `docs/superpowers/plans/2026-10-14-mcp-packages-3-pypi.md`, `docs/superpowers/specs/2026-10-14-mcp-package-install-design.md`

- [ ] **Step 1: Update the docs**

In `docs/mcp.md` replace "A local (stdio) server can come from an npm package instead of an own command (PyPI packages are not supported yet)." with "A local (stdio) server can come from an npm or PyPI package instead of an own command.", and "keep **Registry** at npm" with "choose the **Registry** (npm or PyPI)"; mention that withdrawn (yanked) PyPI versions are marked. Add a paragraph:

"PyPI packages install from wheels into their own virtual environment with AgentPier's CPython 3.14.7 and uv; only `pypi.org` is used. A package that needs a build from source installs only when **Allow install scripts or source builds** is ticked; its build code then already runs while the package is checked, uses the system compiler `cc`, and fetches its build tools (for example setuptools) from PyPI at build time, outside the frozen lock. These build tools are not part of the frozen, hash-checked lock; the confirmation says so. Builds that need Rust or other tools outside `/usr/bin` are not supported. A package that does not support Python 3.14 fails to install. The frozen graph matches the platform it was resolved on; after a restore on another platform, **Reinstall** can fail and an update resolves it again. Moving the data directory leaves the toolchain's build settings pointing at the old path; source builds then need the toolchain to be provisioned again. Qualified servers are listed in [MCP package qualification](mcp-package-qualification.md)."

Add a paragraph on **Dependency constraints**: "For a PyPI package you can enter up to 10 dependency constraints, one per line, each a PyPI package name with version limits (for example `fastmcp<4`). They narrow the resolution when the package is checked, installed or updated; the result is frozen with hashes as usual, **Reinstall** uses the frozen list without resolving again, and an update keeps the constraints unless you change them. URLs, paths, extras and markers are refused. npm packages have no constraints field."

In `docs/AGENTS.md` change "installed from an npm package" to "installed from an npm or PyPI package". Check `README.md`, `README.de.md`, `docs/installation.md` and `docs/linux.md` for npm-only package wording and update what this change affects.

- [ ] **Step 2: Full check**

Run: `npm run check && npm run build && npx playwright test tests/browser/mcp-packages.spec.js tests/browser/agent-mcp-servers.spec.js && AGENTPIER_MCP_PYTHON_TESTS=1 node --test tests/integration/mcp-python-packages.test.js`
Expected: PASS (note the known Unicode login-shell test if it fails locally).

- [ ] **Step 3: Delete the working documents and commit**

```bash
git rm docs/superpowers/plans/2026-10-14-mcp-packages-3-pypi.md \
  docs/superpowers/specs/2026-10-14-mcp-package-install-design.md
git add docs/mcp.md docs/AGENTS.md
git commit -m "docs: describe PyPI MCP packages and remove the working documents

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The PR lists `docs/mcp.md`, `docs/AGENTS.md` and `docs/mcp-package-qualification.md` (and every other doc checked), links AGENTPIER-72, states the OPNsense constraint and the upstream issue status, and includes screenshots of the PyPI form and the OPNsense (or substitute) server's status panel, uploaded to the assets repository.
