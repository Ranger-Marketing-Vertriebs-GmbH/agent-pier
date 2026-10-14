# MCP Packages 3/3: PyPI Packages and Qualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can install a stdio MCP server from a PyPI package at an exact version, wheels only by default and source builds only with the per-package opt-in, and the feature is qualified with real npm and PyPI servers, including a read-only OPNsense server bound to the network architect agent.

**Architecture:** `McpPackages` (plan 2) is split into registry adapters behind one interface: the existing npm code moves into `npm-adapter.js`, and `python-adapter.js` resolves with `uv pip compile --generate-hashes` (trial `--only-binary :all:` first), installs into a relocatable venv with `uv pip sync --require-hashes`, reads programs from the top wheel's `entry_points.txt` with the managed CPython, and generates `<install>/venv/bin/<program>` as the command. Everything else (records, jobs, routes, UI, compilers, grants, backups) is shared.

**Tech Stack:** Node.js ES modules, managed uv 0.12.21 and CPython 3.14.7 (plan 1), `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-mcp-package-install-design.md` (PyPI parts, "Manual qualification", "Resolved questions" 2 and 4).

## Global Constraints

- Depends on plans 1 and 2 merged. Interfaces used exactly as they define them: `ensureToolchain("python", { dataDir })` → `{ kind: "python", directory, uvPath, uvVersion, pythonVersion, pythonPath }`; `packageProblem`, `packageCode`; `stageInstall`, `commitInstall`, `readInstall`, `pruneInstalls`, `installDirectory`, `packageRoot`; `PackageRecords`; `PackageJobs`; `lockDiff`, `lockDigest`; `chooseProgram`.
- Index: only `https://pypi.org/simple` (files from `https://files.pythonhosted.org`); tests inject a local index URL.
- uv environment for every call: `UV_NO_CONFIG=1`, `UV_INDEX_URL=<index>`, `UV_PYTHON_DOWNLOADS=never`, `UV_CACHE_DIR=<data>/mcp-packages/.uv-cache`, private `HOME`/`TMPDIR`, `PATH=/usr/bin:/bin`, plus `proxyEnvironment(process.env)`.
- Without opt-in: `--only-binary :all:` on compile and sync. With opt-in: no such flag (source builds run package build code).
- needsScripts detection: a trial `uv pip compile --only-binary :all:` that fails with uv's "has no usable wheels" / "Wheels are required for" message (spiked with `docopt==0.6.2` on 2026-10-14).
- venvs are created with `uv venv --relocatable` (spiked: console scripts start with `#!/bin/sh` and resolve `python` next to themselves, so the install survives the stage rename).
- A package's `requires_python` that excludes 3.14 fails with `MCP_PACKAGE_INSTALL_FAILED` (owner decision).
- Copy in German and English; files ≤ 600 lines; commits in English with the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.

## Review Focus

1. **A requirements lock with a direct URL, VCS or editable line** (`pkg @ https://…`, `git+`, `-e`, `--extra-index-url`): refused with `MCP_PACKAGE_FOREIGN_SOURCE` before any sync (test in Task 2).
2. **A PyPI release whose top package exists only as sdist and the owner did not opt in:** preview reports `needsScripts: true` and creation is refused with `MCP_PACKAGE_NEEDS_SCRIPTS`; nothing is built (test in Task 4).
3. **Console scripts of dependencies** (the venv's `bin/` also holds e.g. `mcp`, `uvicorn`): only the top distribution's `console_scripts` are offered (test in Task 3).
4. **A yanked version selected deliberately:** installable, marked in the dropdown and the confirmation (test in Task 1 and the browser test in Task 5).
5. **The install directory moved by the stage rename:** the program still starts (relocatable venv), and the receipt check passes (test in Task 4).

---

## File Structure

| File                                                                                           | Responsibility                                                    |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Modify `server/features/mcp-packages/package-spec.js`                                          | `registries` gains `pypi`; PEP 503 names, PEP 440 exact versions. |
| Modify `server/features/mcp-packages/registry-metadata.js`                                     | PyPI JSON → versions (with `yanked`), version files.              |
| Create `server/features/mcp-packages/python-lock-check.js`                                     | Parse and validate `requirements.lock`; dependency list.          |
| Create `server/features/mcp-packages/python-package-install.js`                                | uv compile (trial and real), venv, sync.                          |
| Create `server/features/mcp-packages/wheel-programs.js`                                        | Console scripts from a wheel or an installed `.dist-info`.        |
| Create `server/features/mcp-packages/npm-adapter.js`, `python-adapter.js`                      | Registry adapters with one interface.                             |
| Modify `server/features/mcp-packages/mcp-packages.js`                                          | Uses adapters by `ref.registry`.                                  |
| Modify `server/features/mcp-packages/package-store.js`                                         | `pythonCommand`.                                                  |
| Modify `web/lib/i18n/{de,en}/mcp-packages.js`, `web/features/mcp-servers/McpPackageFields.jsx` | PyPI option, `yanked`.                                            |
| Create `tests/helpers/pypi-index-fixture.js`                                                   | Local PEP 503 index with wheels built by the managed CPython.     |
| Create `docs/mcp-package-qualification.md`; modify `docs/mcp.md`, `docs/AGENTS.md`             | Results and behaviour.                                            |

---

### Task 1: PyPI references and metadata

**Files:**

- Modify: `server/features/mcp-packages/package-spec.js`, `server/features/mcp-packages/registry-metadata.js`
- Test: extend `tests/unit/mcp-package-spec.test.js`, `tests/unit/mcp-registry-metadata.test.js`

**Interfaces:**

- Produces: `registries` = `["npm", "pypi"]`; `normalizePypiName(name)` → PEP 503 form; `pypiRegistry = "https://pypi.org"`; `pypiProject(name, { registry, download })` → JSON of `<registry>/pypi/<name>/json`; `pypiVersions(project)` → `{ latest, versions: [{ version, publishedAt, prerelease, deprecated: false, yanked }] }`; `pypiVersionInfo(project, version)` → `{ files: [{ filename, url, sha256, packagetype }], requiresPython }`. npm versions gain `yanked: false`.

- [ ] **Step 1: Write the failing tests**

```js
// add to tests/unit/mcp-package-spec.test.js
test("PyPI references are normalised and need an exact PEP 440 version", () => {
  assert.deepEqual(
    packageRef({ registry: "pypi", name: "MCP_Server.Time", version: "2026.10.10" }),
    {
      registry: "pypi",
      name: "mcp-server-time",
      version: "2026.10.10",
    },
  );
  assert.deepEqual(
    packageRef({ registry: "pypi", name: "x", version: "1.0rc1" }).version,
    "1.0rc1",
  );
  for (const version of ["~=1.0", ">=1", "1.*", "1.0 ; python_version<'3'", "latest"])
    assert.throws(
      () => packageRef({ registry: "pypi", name: "x", version }),
      { code: "MCP_PACKAGE_INVALID" },
      version,
    );
  for (const name of ["-x", "x-", "a b", "x@https://e", "../x"])
    assert.throws(
      () => packageRef({ registry: "pypi", name, version: "1.0" }),
      { code: "MCP_PACKAGE_INVALID" },
      name,
    );
});
```

```js
// add to tests/unit/mcp-registry-metadata.test.js
import {
  pypiVersionInfo,
  pypiVersions,
} from "../../server/features/mcp-packages/registry-metadata.js";

const project = {
  info: { version: "1.1" },
  releases: {
    "1.0": [
      {
        filename: "x-1.0-py3-none-any.whl",
        url: "https://files.pythonhosted.org/x-1.0.whl",
        digests: { sha256: "a" },
        packagetype: "bdist_wheel",
        upload_time_iso_8601: "2026-01-01T00:00:00Z",
        yanked: true,
        requires_python: ">=3.10",
      },
    ],
    1.1: [
      {
        filename: "x-1.1.tar.gz",
        url: "https://files.pythonhosted.org/x-1.1.tar.gz",
        digests: { sha256: "b" },
        packagetype: "sdist",
        upload_time_iso_8601: "2026-02-01T00:00:00Z",
        yanked: false,
        requires_python: ">=3.10",
      },
    ],
    "2.0b1": [
      {
        filename: "x-2.0b1-py3-none-any.whl",
        url: "https://files.pythonhosted.org/x-2.0b1.whl",
        digests: { sha256: "c" },
        packagetype: "bdist_wheel",
        upload_time_iso_8601: "2026-03-01T00:00:00Z",
        yanked: false,
      },
    ],
    0.9: [],
  },
};

test("PyPI versions skip empty releases and mark prereleases and yanked ones", () => {
  assert.deepEqual(pypiVersions(project), {
    latest: "1.1",
    versions: [
      {
        version: "2.0b1",
        publishedAt: "2026-03-01T00:00:00Z",
        prerelease: true,
        deprecated: false,
        yanked: false,
      },
      {
        version: "1.1",
        publishedAt: "2026-02-01T00:00:00Z",
        prerelease: false,
        deprecated: false,
        yanked: false,
      },
      {
        version: "1.0",
        publishedAt: "2026-01-01T00:00:00Z",
        prerelease: false,
        deprecated: false,
        yanked: true,
      },
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

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/mcp-package-spec.test.js tests/unit/mcp-registry-metadata.test.js`
Expected: FAIL (`pypi` refused; functions missing).

- [ ] **Step 3: Implement**

In `package-spec.js`:

```js
export const registries = ["npm", "pypi"];
// PEP 508 project names; compared in their PEP 503 normalised form.
const pypiName = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/;
export const normalizePypiName = (name) => name.replace(/[-_.]+/g, "-").toLowerCase();
// A PEP 440 public version, exact: no specifier, wildcard or marker.
const pypiVersion =
  /^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/i;
```

Extend `names` with `pypi: (name) => pypiName.test(name)` and `versions` with `pypi: (version) => version.length <= 128 && pypiVersion.test(version)`. In `packageName` return `registry === "pypi" ? normalizePypiName(name) : name`.

In `registry-metadata.js`:

```js
export const pypiRegistry = "https://pypi.org";
export const pypiProject = (name, { registry = pypiRegistry, download } = {}) =>
  fetchRegistryJson(`${registry}/pypi/${encodeURIComponent(name)}/json`, { download });
const pypiPrerelease = /(?:a|b|rc|\.dev)\d+/i;

export function pypiVersions(project) {
  const versions = Object.entries(project?.releases || {})
    .filter(([, files]) => Array.isArray(files) && files.length)
    .map(([version, files]) => ({
      version,
      publishedAt:
        files
          .map((f) => f.upload_time_iso_8601)
          .filter(Boolean)
          .sort()[0] ?? null,
      prerelease: pypiPrerelease.test(version),
      deprecated: false,
      yanked: files.every((f) => f.yanked === true),
    }))
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
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

Add `yanked: false` to each entry of `npmVersions` and update the npm test expectation accordingly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/mcp-package-spec.test.js tests/unit/mcp-registry-metadata.test.js`
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

- Produces: `checkPythonLock(text, { ref, digests = null })` → `{ digest, dependencies: [{ name, version }], hashes: Map<name, string[]> }`; `digests` (array of sha256 from PyPI for the top release) is checked when given: every top-level hash in the lock must be one of them, else `MCP_PACKAGE_INTEGRITY_MISMATCH`.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/mcp-python-lock-check.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { checkPythonLock } from "../../server/features/mcp-packages/python-lock-check.js";

const ref = { registry: "pypi", name: "mcp-server-time", version: "2026.10.10" };
const lock = (
  extra = "",
) => `# This file was autogenerated by uv via the following command:
#    uv pip compile requirements.in --generate-hashes
mcp-server-time==2026.10.10 \\
    --hash=sha256:aaa \\
    --hash=sha256:bbb
    # via -r requirements.in
Tzdata==2026.1 \\
    --hash=sha256:ccc
    # via mcp-server-time
${extra}`;

test("a hashed PyPI lock yields normalised dependencies and its digest", () => {
  const result = checkPythonLock(lock(), { ref, digests: ["aaa", "bbb", "zzz"] });
  assert.deepEqual(result.dependencies, [
    { name: "mcp-server-time", version: "2026.10.10" },
    { name: "tzdata", version: "2026.1" },
  ]);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
});

test("direct URLs, VCS, editable and extra index lines are foreign", () => {
  for (const line of [
    "evil @ https://example.com/evil.whl \\\n    --hash=sha256:ddd",
    "-e git+https://github.com/a/b.git#egg=b",
    "--extra-index-url https://example.com/simple",
    "--index-url https://example.com/simple",
    "--find-links /tmp",
    "b @ file:///tmp/b.whl",
  ])
    assert.throws(
      () => checkPythonLock(lock(line), { ref }),
      { code: "MCP_PACKAGE_FOREIGN_SOURCE" },
      line,
    );
});

test("a package without a hash is refused", () => {
  assert.throws(() => checkPythonLock(lock("idna==3.10\n    # via x"), { ref }), {
    code: "MCP_PACKAGE_FOREIGN_SOURCE",
  });
});

test("top-level hashes must come from the PyPI release", () => {
  assert.throws(() => checkPythonLock(lock(), { ref, digests: ["aaa"] }), {
    code: "MCP_PACKAGE_INTEGRITY_MISMATCH",
  });
  assert.throws(() => checkPythonLock(lock(), { ref: { ...ref, version: "1.0" } }), {
    code: "MCP_PACKAGE_INTEGRITY_MISMATCH",
  });
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
import { normalizePypiName } from "./package-spec.js";

const foreign = () => packageProblem("MCP_PACKAGE_FOREIGN_SOURCE", 400);
const requirement = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\\;]+)\s*\\?$/;
const hash = /^--hash=sha256:([0-9a-f]+)\s*\\?$/;

/**
 * Validates a `uv pip compile --generate-hashes` lock: only `name==version` lines from
 * the configured index, each with at least one sha256 hash, no option lines.
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
      versions.set(current, req[2]);
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
  for (const [name, list] of hashes) if (!list.length) throw foreign(name);
  if (versions.get(ref.name) !== ref.version)
    throw packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
  if (digests && !hashes.get(ref.name).every((h) => digests.includes(h)))
    throw packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
  const dependencies = [...versions]
    .map(([name, version]) => ({ name, version }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { digest: lockDigest(text), dependencies, hashes };
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
  - `wheelEntryPoints({ python, wheelFile, execute? })` → entry-points text or `""`; runs `python -I -c <reader> <wheelFile>` (reads only `*.dist-info/entry_points.txt` with `zipfile`).
  - `installedEntryPoints(venvDir, name)` → text of `<site-packages>/<dist>.dist-info/entry_points.txt` for the distribution whose normalised name is `name`, or `""`.
  - `pythonCommand(dataDir, receipt)` → `{ command: <install>/venv/bin/<program.path>, leading: [] }`; refuses a program outside the install (`MCP_PACKAGE_NO_PROGRAM`).

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
});

test("the Python command is the venv script inside the install", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "py-command-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { installId, stage } = stageInstall(dataDir);
  fs.mkdirSync(path.join(stage, "venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(stage, "venv", "bin", "srv"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  const receipt = { program: { name: "srv", path: "srv" }, lockDigest: "d" };
  const final = commitInstall(dataDir, { installId, stage, receipt });
  assert.deepEqual(pythonCommand(dataDir, { ...receipt, installId }), {
    command: path.join(final, "venv", "bin", "srv"),
    leading: [],
  });
  assert.throws(
    () =>
      pythonCommand(dataDir, {
        ...receipt,
        installId,
        program: { name: "x", path: "../x" },
      }),
    {
      code: "MCP_PACKAGE_NO_PROGRAM",
    },
  );
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
const scriptName = /^[A-Za-z0-9._-]{1,100}$/;

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

`package-store.js` addition:

```js
export function pythonCommand(dataDir, receipt) {
  const directory = installDirectory(dataDir, receipt.installId);
  const bin = path.join(directory, "venv", "bin");
  const program = path.join(bin, receipt.program.path);
  if (path.dirname(program) !== bin) throw packageProblem("MCP_PACKAGE_NO_PROGRAM", 502);
  try {
    regularFile(program, "MCP_PACKAGE_NO_PROGRAM");
  } catch {
    throw packageProblem("MCP_PACKAGE_NO_PROGRAM", 502);
  }
  return { command: program, leading: [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/mcp-wheel-programs.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-packages/wheel-programs.js server/features/mcp-packages/package-store.js \
  tests/unit/mcp-wheel-programs.test.js
git commit -m "feat: find console scripts of Python MCP server packages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Python installer, adapters and the service

**Files:**

- Create: `server/features/mcp-packages/python-package-install.js`
- Create: `server/features/mcp-packages/npm-adapter.js`, `server/features/mcp-packages/python-adapter.js`
- Modify: `server/features/mcp-packages/mcp-packages.js`
- Create: `tests/helpers/pypi-index-fixture.js`
- Test: `tests/integration/mcp-python-packages.test.js` (runs only when `AGENTPIER_MCP_PYTHON_TESTS=1`, see Step 5); rerun `tests/integration/mcp-packages-service.test.js`

**Interfaces:**

- `python-package-install.js`:
  - `resolvePython({ stage, ref, python, index, cacheDir, allowScripts, execute?, environment?, log? })` → `{ requirementsText, lockText, needsScripts }`; when the trial `--only-binary :all:` compile fails with uv's no-wheel message: `needsScripts: true` and, without `allowScripts`, `lockText: null`.
  - `installPython({ directory, requirementsText, lockText, python, index, cacheDir, allowScripts, execute?, environment?, log? })` → void (venv at `<directory>/venv`).
- Adapter interface (both files export an object with exactly these members):
  - `toolchainKind`: `"node"` | `"python"`.
  - `versions(name, { registry, download })` → `{ latest, versions }`.
  - `preview({ ref, allowScripts, toolchain, stage, registry, download, cacheDir, execute, environment })` → `{ integrity, programs, needsScripts, manifestText, lockText, digest, dependencies }` (`manifestText` is the npm `package.json` or the Python `requirements.in`).
  - `checkStored(row, { registry })` → `{ dependencies }` (re-checks a stored lock for diffs and reinstalls).
  - `install({ directory, preview, toolchain, registry, cacheDir, execute, environment, log })` → void.
  - `programsAfterInstall(directory, ref)` → programs (`[]` for npm; Python reads the installed `.dist-info`).
  - `command(dataDir, receipt, toolchain)` → `{ command, leading }`.
- `McpPackages` constructor gains `registries = { npm: npmRegistry, pypi: pypiIndexRegistry }` and `adapters = { npm: npmAdapter, pypi: pythonAdapter }`; the npm-specific calls inside `preview`, `install`, `reinstall` and `versions` go through `this.adapters[ref.registry]` with `this.registries[ref.registry]`; `toolchain(kind)` is called with `adapter.toolchainKind`. For a Python top package that has no wheel (allowed sdist), `preview.programs` is empty: `createServer` then stores `program: null` and the install job chooses with `chooseProgram(adapter.programsAfterInstall(stage, ref), wanted)` before committing. Records store `leadingArgs` from `command().leading.length` (1 for npm, 0 for Python), so the owner-args logic of plan 2 is unchanged.
- `pypiIndexRegistry` = `{ api: "https://pypi.org", index: "https://pypi.org/simple" }`.

- [ ] **Step 1: Build the local index fixture**

```js
// tests/helpers/pypi-index-fixture.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// Builds a minimal wheel with the managed CPython's zipfile (no build backend).
const builder = `
import sys, zipfile, json
spec = json.loads(sys.argv[2])
dist = spec["name"].replace("-", "_") + "-" + spec["version"]
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr(spec["module"] + "/__init__.py", "def main():\\n    print('ok')\\n")
    meta = "Metadata-Version: 2.1\\nName: %s\\nVersion: %s\\n" % (spec["name"], spec["version"])
    for dep in spec.get("requires", []): meta += "Requires-Dist: %s\\n" % dep
    z.writestr(dist + ".dist-info/METADATA", meta)
    z.writestr(dist + ".dist-info/WHEEL", "Wheel-Version: 1.0\\nGenerator: fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")
    if spec.get("script"):
        z.writestr(dist + ".dist-info/entry_points.txt", "[console_scripts]\\n%s = %s:main\\n" % (spec["script"], spec["module"]))
    z.writestr(dist + ".dist-info/RECORD", "")
`;

/**
 * A PEP 503 simple index plus the PyPI JSON API for the given packages. Packages
 * with `sdistOnly` get a fake sdist and no wheel.
 */
export async function pypiIndexFixture(t, python, packages) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pypi-index-"));
  const files = new Map();
  const projects = new Map();
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("#")[0]);
    if (files.has(url)) return res.end(files.get(url));
    const simple = /^\/simple\/([^/]+)\/?$/.exec(url);
    if (simple && projects.has(simple[1])) {
      res.setHeader("content-type", "text/html");
      return res.end(projects.get(simple[1]).links.join("\n"));
    }
    const json = /^\/pypi\/([^/]+)\/json$/.exec(url);
    if (json && projects.has(json[1]))
      return res.end(JSON.stringify(projects.get(json[1]).json));
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  });
  for (const pkg of packages) {
    const module = pkg.name.replace(/-/g, "_");
    const filename = pkg.sdistOnly
      ? `${module}-${pkg.version}.tar.gz`
      : `${module}-${pkg.version}-py3-none-any.whl`;
    const file = path.join(work, filename);
    if (pkg.sdistOnly) fs.writeFileSync(file, "not a real sdist");
    else
      execFileSync(python.pythonPath, [
        "-I",
        "-c",
        builder,
        file,
        JSON.stringify({ ...pkg, module }),
      ]);
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
      {
        filename,
        url: `${base}/files/${filename}`,
        digests: { sha256 },
        packagetype: pkg.sdistOnly ? "sdist" : "bdist_wheel",
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

- [ ] **Step 2: Write the failing integration test**

```js
// tests/integration/mcp-python-packages.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pypiIndexFixture } from "../helpers/pypi-index-fixture.js";
import { ensureToolchain } from "../../server/features/mcp-packages/toolchains.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";
import { McpPackages } from "../../server/features/mcp-packages/mcp-packages.js";

const enabled = process.env.AGENTPIER_MCP_PYTHON_TESTS === "1";
// One real toolchain per machine, outside the per-test data dirs.
const shared = path.join(os.tmpdir(), "agentpier-test-toolchains");

async function setup(t, packages) {
  const python = await ensureToolchain("python", { dataDir: shared });
  const index = await pypiIndexFixture(t, python, packages);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-python-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const servers = new McpServerStore({ dataDir });
  const changes = new CentralMcpChanges({ servers });
  const service = new McpPackages({
    dataDir,
    servers,
    changes,
    registries: { npm: "unused", pypi: { api: index.api, index: index.index } },
    download: async (url) => Buffer.from(await (await fetch(url)).arrayBuffer()),
    toolchain: async () => python,
  });
  return { dataDir, servers, service };
}
const server = {
  name: "srv-x",
  version: "1.0",
  script: "srv-x",
  requires: ["helper-x==2.0"],
};
const helper = { name: "helper-x", version: "2.0", script: "helper-tool" };

test(
  "a wheel-only package installs into a relocatable venv and starts",
  { skip: !enabled },
  async (t) => {
    const s = await setup(t, [server, helper]);
    const preview = await s.service.preview({
      registry: "pypi",
      name: "srv-x",
      version: "1.0",
    });
    assert.deepEqual(preview.programs, ["srv-x"]);
    assert.equal(preview.needsScripts, false);
    assert.equal(preview.dependencyCount, 2);
    const created = await s.service.createServer(
      {
        name: "py",
        transport: "stdio",
        source: { registry: "pypi", name: "srv-x", version: "1.0" },
      },
      { previewId: preview.previewId },
    );
    await s.service.jobs.idle();
    const ready = s.servers.get(created.id);
    assert.equal(ready.source.status, "ready");
    assert.match(
      ready.command,
      /mcp-packages\/installs\/[0-9a-f-]{36}\/venv\/bin\/srv-x$/,
    );
    assert.equal(execFileSync(ready.command).toString().trim(), "ok");
  },
);

test(
  "an sdist-only package needs the opt-in and is refused without it",
  { skip: !enabled },
  async (t) => {
    const s = await setup(t, [{ name: "old-x", version: "1.0", sdistOnly: true }]);
    const preview = await s.service.preview({
      registry: "pypi",
      name: "old-x",
      version: "1.0",
    });
    assert.equal(preview.needsScripts, true);
    await assert.rejects(
      s.service.createServer(
        {
          name: "old",
          transport: "stdio",
          source: { registry: "pypi", name: "old-x", version: "1.0" },
        },
        { previewId: preview.previewId },
      ),
      { code: "MCP_PACKAGE_NEEDS_SCRIPTS" },
    );
  },
);

test("reinstall uses the stored lock only", { skip: !enabled }, async (t) => {
  const s = await setup(t, [server, helper]);
  const preview = await s.service.preview({
    registry: "pypi",
    name: "srv-x",
    version: "1.0",
  });
  const created = await s.service.createServer(
    {
      name: "py",
      transport: "stdio",
      source: { registry: "pypi", name: "srv-x", version: "1.0" },
    },
    { previewId: preview.previewId },
  );
  await s.service.jobs.idle();
  fs.rmSync(path.join(s.dataDir, "mcp-packages", "installs"), { recursive: true });
  assert.equal(s.servers.get(created.id).source.status, "missing");
  s.service.reinstall(created.id);
  await s.service.jobs.idle();
  assert.equal(s.servers.get(created.id).source.status, "ready");
});
```

Run: `AGENTPIER_MCP_PYTHON_TESTS=1 node --test tests/integration/mcp-python-packages.test.js`
Expected: FAIL (adapters missing). The first run downloads the real toolchain (~60 MB) into `$TMPDIR/agentpier-test-toolchains`.

- [ ] **Step 3: Implement the installer**

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
const noWheel = /has no usable wheels|Wheels are required for/;

function uvEnvironment({ work, index, cacheDir, environment }) {
  for (const name of ["home", "tmp"]) privateFolder(path.join(work, name));
  return {
    ...proxyEnvironment(environment),
    HOME: path.join(work, "home"),
    TMPDIR: path.join(work, "tmp"),
    PATH: `/usr/bin${path.delimiter}/bin`,
    UV_NO_CONFIG: "1",
    UV_INDEX_URL: index,
    UV_PYTHON_DOWNLOADS: "never",
    UV_CACHE_DIR: privateFolder(cacheDir),
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
    return { ok: true, stderr };
  } catch (error) {
    log?.(`${error.stdout || ""}\n${error.stderr || ""}`);
    return { ok: false, stderr: String(error.stderr || "") };
  }
}

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
    const env = uvEnvironment({ work, index, cacheDir, environment });
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
      if (!noWheel.test(trial.stderr))
        throw packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502);
      needsScripts = true;
      if (!allowScripts) return { requirementsText, lockText: null, needsScripts };
      if (!(await compile([])).ok)
        throw packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502);
    }
    return { requirementsText, lockText: fs.readFileSync(output, "utf8"), needsScripts };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

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
  fs.writeFileSync(path.join(directory, "requirements.in"), requirementsText, {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(directory, "requirements.lock"), lockText, { mode: 0o600 });
  const work = privateFolder(path.join(directory, ".uv-work"));
  try {
    const env = uvEnvironment({ work, index, cacheDir, environment });
    const venv = path.join(directory, "venv");
    const binary = allowScripts ? [] : ["--only-binary", ":all:"];
    if (
      !(
        await uv(python, ["venv", "--relocatable", "--python", python.pythonPath, venv], {
          env,
          execute,
          log,
        })
      ).ok
    )
      throw packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502);
    const sync = await uv(
      python,
      [
        "pip",
        "sync",
        path.join(directory, "requirements.lock"),
        "--require-hashes",
        "--python",
        path.join(venv, "bin", "python"),
        ...binary,
      ],
      { env, execute, log },
    );
    if (!sync.ok) throw packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Implement the adapters and route the service through them**

`npm-adapter.js` wraps the plan 2 npm code unchanged (`npmPackument`, `npmVersions`, `npmVersionInfo`, `npmPrograms`, `resolveNpm`, `installNpm`, `checkNpmLock`, `npmManifestText`, `npmCommand`) into the interface; `programsAfterInstall` returns `[]`. Move the npm lines out of `McpPackages.preview` and `McpPackages.install` into it verbatim.

`python-adapter.js`:

```js
import fs from "node:fs";
import path from "node:path";
import { download as fetchDownload } from "../operations/releases.js";
import { checkPythonLock } from "./python-lock-check.js";
import { installPython, resolvePython } from "./python-package-install.js";
import { pythonCommand } from "./package-store.js";
import { packageProblem } from "./package-errors.js";
import { pypiProject, pypiVersionInfo, pypiVersions } from "./registry-metadata.js";
import {
  consoleScripts,
  installedEntryPoints,
  wheelEntryPoints,
} from "./wheel-programs.js";
import { sha256Matches } from "./verified-files.js";

export const pypiIndexRegistry = {
  api: "https://pypi.org",
  index: "https://pypi.org/simple",
};
const fileHosts = ["https://files.pythonhosted.org/"];

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
    const digests = info.files.map((f) => f.sha256);
    const resolved = await resolvePython({
      stage,
      ref,
      python: toolchain,
      index: registry.index,
      cacheDir,
      allowScripts,
      execute,
      environment,
    });
    if (!resolved.lockText)
      return {
        integrity: `sha256:${digests[0]}`,
        programs: [],
        needsScripts: true,
        manifestText: resolved.requirementsText,
        lockText: null,
        digest: null,
        dependencies: [],
      };
    const checked = checkPythonLock(resolved.lockText, { ref, digests });
    const wheel =
      info.files.find(
        (f) =>
          f.packagetype === "bdist_wheel" && f.filename.endsWith("-py3-none-any.whl"),
      ) || info.files.find((f) => f.packagetype === "bdist_wheel");
    let programs = [];
    if (wheel) {
      const allowedHost =
        registry.api !== pypiIndexRegistry.api ||
        fileHosts.some((host) => wheel.url.startsWith(host));
      if (!allowedHost) throw packageProblem("MCP_PACKAGE_FOREIGN_SOURCE", 400);
      const bytes = await (
        download || ((url) => fetchDownload(url, fetch, 256 * 1024 * 1024))
      )(wheel.url);
      if (!sha256Matches(bytes, wheel.sha256))
        throw packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
      const file = path.join(stage, wheel.filename.replace(/[^A-Za-z0-9._-]/g, "_"));
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      programs = consoleScripts(
        await wheelEntryPoints({ python: toolchain, wheelFile: file, execute }),
      );
    }
    return {
      integrity: `sha256:${wheel?.sha256 ?? digests[0]}`,
      programs,
      needsScripts: resolved.needsScripts,
      manifestText: resolved.requirementsText,
      lockText: resolved.lockText,
      digest: checked.digest,
      dependencies: checked.dependencies,
    };
  },
  checkStored(row) {
    return checkPythonLock(row.lock, { ref: row });
  },
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
  command(dataDir, receipt) {
    return pythonCommand(dataDir, receipt);
  },
};
```

`McpPackages` changes (keep the plan 2 structure; only these points change):

- Constructor: `registries = { npm: npmRegistry, pypi: pypiIndexRegistry }`, `adapters = { npm: npmAdapter, pypi: pythonAdapter }`; drop the single `registry` option (tests of plan 2 pass `registries: { npm: registry.url, pypi: pypiIndexRegistry }`; update `tests/integration/mcp-packages-service.test.js` setup accordingly).
- `cacheDir(kind)`: `.npm-cache` for npm, `.uv-cache` for Python, both under `packageRoot`.
- `preview`: `const adapter = this.adapters[ref.registry]; const toolchain = await this.toolchain(adapter.toolchainKind);` then `adapter.preview({ ref, allowScripts, toolchain, stage, registry: this.registries[ref.registry], download: this.download, cacheDir: this.cacheDir(ref.registry), execute: this.execute, environment: this.environment })`. `diff` uses `adapter.checkStored(current, …).dependencies`. A preview with `lockText === null` is still stored (so the confirmation shows `needsScripts`), but `createServer` and `updatePackage` refuse it with `MCP_PACKAGE_NEEDS_SCRIPTS`.
- `createServer`/`updatePackage`: `chooseProgram` runs only when `preview.programs.length`; otherwise the record stores `program: ""`, `programPath: ""` and the job decides after install.
- `install` job: `await adapter.install({ directory: stage, preview, toolchain, … })`; if `!program?.name`, `program = chooseProgram(adapter.programsAfterInstall(stage, preview.ref), undefined)`; receipt `toolchain: { kind: adapter.toolchainKind, version: toolchain.version ?? toolchain.pythonVersion, directory: toolchain.directory }`; `const { command, leading } = adapter.command(this.dataDir, { ...receipt, installId }, toolchain);`.
- `reinstall`: preview object built from the record with `manifestText: row.registry === "npm" ? npmManifestText(ref) : \`${ref.name}==${ref.version}\n\``, and `adapter.checkStored(row, { registry })`instead of`checkNpmLock`.

- [ ] **Step 5: Run the tests and add the CI step**

Run: `node --test tests/integration/mcp-packages-service.test.js && AGENTPIER_MCP_PYTHON_TESTS=1 node --test tests/integration/mcp-python-packages.test.js`
Expected: PASS (3 Python tests, plus the npm tests unchanged).

In `.github/workflows/mcp-toolchains.yml` (plan 1), add after the verify step:

```yaml
- name: Python package installs against a local index
  env:
    AGENTPIER_MCP_PYTHON_TESTS: "1"
  run: node --test tests/integration/mcp-python-packages.test.js
```

and add `"server/features/mcp-packages/**"` and `"tests/**/mcp-python*"` to both `paths` lists.

- [ ] **Step 6: Commit**

```bash
git add server/features/mcp-packages tests/helpers/pypi-index-fixture.js tests/integration .github/workflows/mcp-toolchains.yml
git commit -m "feat: install PyPI MCP server packages with uv

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: PyPI in the form

**Files:**

- Modify: `web/lib/i18n/de/mcp-packages.js`, `web/lib/i18n/en/mcp-packages.js` (`registries.pypi`, `yanked`)
- Modify: `web/features/mcp-servers/McpPackageFields.jsx`, `McpPackageConfirmation.jsx`
- Test: extend `tests/browser/mcp-packages.spec.js`

- [ ] **Step 1: Copy**

English: `registries: { npm: "npm", pypi: "PyPI" }`, `yanked: "withdrawn by its author"`, `noProgramsYet: "The program is chosen after the build."`. German: `registries: { npm: "npm", pypi: "PyPI" }`, `yanked: "vom Autor zurückgezogen"`, `noProgramsYet: "Das Programm wird nach dem Build gewählt."`.

- [ ] **Step 2: Failing browser test**

```js
test("a PyPI package shows yanked versions marked and installs", async ({ page }) => {
  const state = await setup(page);
  await page.route(/\/api\/mcp-packages\/versions/, (route) =>
    route.fulfill({
      json: {
        latest: "0.4.1",
        versions: [
          {
            version: "0.4.1",
            publishedAt: "2026-10-01T00:00:00Z",
            prerelease: false,
            deprecated: false,
            yanked: false,
          },
          {
            version: "0.4.0",
            publishedAt: "2026-09-01T00:00:00Z",
            prerelease: false,
            deprecated: false,
            yanked: true,
          },
        ],
      },
    }),
  );
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("region", { name: "MCP servers" })
    .getByRole("button", { name: "Add MCP server" })
    .click();
  const dialog = accountDetail(page);
  await dialog.getByLabel("Name", { exact: true }).fill("opnsense");
  await dialog.getByRole("radio", { name: "Local command (stdio)" }).check();
  await dialog.getByRole("radio", { name: "Install package" }).check();
  await dialog.getByRole("radio", { name: "PyPI" }).check();
  await dialog.getByLabel("Package").fill("opnsense-mcp-server");
  await expect(
    dialog
      .getByLabel("Version")
      .locator("option", { hasText: "withdrawn by its author" }),
  ).toHaveCount(1);
  await dialog.getByRole("button", { name: "Save server" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Install" }).click();
  expect(state.requests.find((r) => r.path === "servers").body.source).toMatchObject({
    registry: "pypi",
    name: "opnsense-mcp-server",
    version: "0.4.1",
  });
});
```

Run: `npm run build && npx playwright test tests/browser/mcp-packages.spec.js` → FAIL (no PyPI option).

- [ ] **Step 3: Implement**

`McpPackageFields.jsx`: registry `Segment` options `["npm", "pypi"]` with `copy.registries`; version option label appends ` · ${copy.yanked}` when `v.yanked`. `McpPackageConfirmation.jsx`: when `preview.programs.length === 0 && !preview.needsScripts` is impossible; when `preview.programs.length === 0` show `copy.noProgramsYet`.

Run: `npm run build && npx playwright test tests/browser/mcp-packages.spec.js && node --test tests/unit/i18n-catalogs.test.js` → PASS.

- [ ] **Step 4: Commit**

```bash
git add web tests/browser/mcp-packages.spec.js
git commit -m "feat: offer PyPI as an MCP package registry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Review the OPNsense server before installing it

**Files:**

- Create: `docs/mcp-package-qualification.md` (first section)

Facts known on 2026-10-14: the PyPI project is `opnsense-mcp-server`, latest `0.4.1`, `requires_python >=3.11`, source `https://github.com/lucamarien/opnsense-mcp-server`. Its README states read-only by default with writes behind an explicit opt-in and blocked dangerous endpoints; this is a claim to verify, not a fact.

- [ ] **Step 1: Download and inspect the exact release without running it**

```bash
D=$(mktemp -d) && cd "$D"
curl -sSL https://pypi.org/pypi/opnsense-mcp-server/0.4.1/json -o meta.json
python3 -I -c "import json;d=json.load(open('meta.json'));[print(f['filename'],f['digests']['sha256'],f['url']) for f in d['urls']]"
# download the wheel listed above, check its sha256 matches, then:
python3 -I -m zipfile -l opnsense_mcp_server-0.4.1-py3-none-any.whl
python3 -I -m zipfile -e opnsense_mcp_server-0.4.1-py3-none-any.whl src
grep -rn -i -E "allow.?write|read.?only|write_enabled|POST|reboot|firmware|upgrade|halt" src | head -80
```

Expected: identify (a) the setting that enables writes and its default, (b) where the HTTP client issues non-GET requests, (c) the blocklist for reboot/firmware endpoints, (d) whether any tool performs a write without the opt-in. Record file and line references.

- [ ] **Step 2: Write the findings**

`docs/mcp-package-qualification.md`:

```markdown
# MCP package qualification

Managed MCP server packages (see [MCP](mcp.md#installing-a-server-package)) were
qualified on <date> on <platform>, AgentPier <commit>, toolchains Node 26.7.0,
uv 0.12.21 and CPython 3.14.7.

## OPNsense server review (opnsense-mcp-server 0.4.1)

- Wheel `<filename>`, SHA-256 `<hash>` (matches PyPI).
- Write switch: `<setting>`, default `<value>` (`<file>:<line>`).
- Non-GET requests: `<file>:<line>` … only reachable when `<condition>`.
- Blocked endpoints: `<list>` (`<file>:<line>`).
- Verdict: <read-only by default: yes/no, with the evidence above>.
```

Fill every `<…>` with what Step 1 found. If writes are reachable without the opt-in, stop: report to the owner and do not install it for the agent.

- [ ] **Step 3: Commit**

```bash
git add docs/mcp-package-qualification.md
git commit -m "docs: record the OPNsense MCP server review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Manual qualification with real servers

The owner provides, at this point: a restricted OPNsense API key and secret (a dedicated user and group with status/diagnostics read privileges only), the OPNsense address and its CA certificate, and confirms which agent is the network architect. Keys go into the server's environment variables in the form only; never into a file in the repo, a log or this document.

**Files:**

- Modify: `docs/mcp-package-qualification.md`

- [ ] **Step 1: Run a disposable AgentPier**

```bash
npm run build
export AGENTPIER_DATA_DIR=$(mktemp -d)
npm start
```

Use a disposable Claude Code profile (the isolated-profile approach in `docs/mcp.md` "Verification limits"); never the owner's real `~/.claude.json`.

- [ ] **Step 2: Install, bind and call each server**

For each row, create the server from the form (latest stable version), wait for **Installed**, bind it to one agent and to Claude Code, and make one real tool call from each:

| Server                                    | Registry                                                                                         | Arguments / env                             | Tool call                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- | --------------------------------- |
| `@modelcontextprotocol/server-memory`     | npm                                                                                              | —                                           | create an entity, read it back    |
| `@modelcontextprotocol/server-filesystem` | npm                                                                                              | an allowed directory, e.g. a temp dir       | list the directory                |
| `mcp-server-time`                         | PyPI                                                                                             | —                                           | current time in Europe/Berlin     |
| `mcp-server-fetch`                        | PyPI                                                                                             | —                                           | fetch `https://example.com`       |
| `opnsense-mcp-server`                     | PyPI                                                                                             | the owner's restricted key, secret, URL, CA | list interfaces or gateway status |
| one opt-in package                        | PyPI (sdist only, e.g. `docopt` as a dependency of a small server) or npm with an install script | allow scripts/builds                        | start and one call                |

For the opt-in row, first confirm that without the opt-in the preview shows the needs-scripts notice and **Install** stays disabled.

Also check: update one server to an older/newer version and see the diff; delete its install directory and use **Reinstall**; remove a server and confirm `mcp-packages/installs/` no longer holds its directory.

- [ ] **Step 3: Record results**

Append to `docs/mcp-package-qualification.md` a table: server, version, registry, install time, agent call result, Claude Code call result, notes; plus the update/reinstall/remove checks. Linux results come from the `mcp-toolchains` workflow (toolchains and the local-index Python tests); state that real-server calls were run on macOS only unless the owner provides a Linux host.

- [ ] **Step 4: Commit**

```bash
git add docs/mcp-package-qualification.md
git commit -m "docs: record the MCP package qualification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Docs, full check and cleanup

**Files:**

- Modify: `docs/mcp.md` ("Installing a server package": registries npm and PyPI; wheels only unless source builds are allowed; Python 3.14.7; link the qualification doc)
- Modify: `docs/AGENTS.md` (MCP bullet: "from an npm or PyPI package")
- Delete: `docs/superpowers/plans/2026-10-14-mcp-packages-3-pypi.md`, `docs/superpowers/specs/2026-10-14-mcp-package-install-design.md`

- [ ] **Step 1: Update the docs**

In `docs/mcp.md` change "a registry (npm)" to "a registry (npm or PyPI)" and add: "PyPI packages install from wheels into their own virtual environment with AgentPier's CPython 3.14.7; a package that needs a build from source installs only when **install scripts or source builds** are allowed for it. A package that does not support Python 3.14 fails to install. Qualified servers are listed in [MCP package qualification](mcp-package-qualification.md)."

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

The PR lists `docs/mcp.md`, `docs/AGENTS.md` and `docs/mcp-package-qualification.md`, links AGENTPIER-72, and includes screenshots of the PyPI form and the OPNsense server's status panel.
