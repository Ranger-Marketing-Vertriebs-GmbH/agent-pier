# MCP Packages 1/3: Managed Toolchains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AgentPier provisions a pinned, checksum-verified Node toolchain and a pinned `uv` plus CPython toolchain under `<data>/toolchains/`, through the installer, the update path and on demand, so later PRs can install MCP server packages without anything installed on the host.

**Architecture:** A pure manifest (`toolchain-manifest.js`) pins versions and SHA-256 sums per target. `toolchains.js` downloads with the existing `download()` helper, verifies, extracts into a `.stage-<uuid>` directory, checks the binaries and renames the stage into place with a `receipt.json`; a reader re-verifies the receipt without downloading. CPython is installed by the managed `uv` from a local `file://` mirror that holds only the archive AgentPier verified itself. A provisioning wrapper never fails the installer, and a background stage after an update prepares new pins only when an older toolchain is already present.

**Tech Stack:** Node.js ES modules, `node:test` with strict assertions, real `tar`, POSIX shell fixtures, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-14-mcp-package-install-design.md` (sections "Architecture → toolchains.js", "Delivery 1", "Resolved questions" 1–3, 5).

## Global Constraints

- Platforms: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`; Linux glibc only. A musl host or any other target fails with code `MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE`.
- Node toolchain: version `26.7.0`, bundled npm `11.19.0`, checksums reused from `runtimeManifest.nodeChecksums` (`server/features/assistants/runtime-manifest.js`), separate from the OpenClaw runtime copy.
- uv: version `0.12.21` (released 2026-09-29; the newer 0.13.x line was under two weeks old on 2026-10-14), asset `uv-<triple>.tar.gz` from `https://github.com/astral-sh/uv/releases/download/0.12.21/`, SHA-256 pinned below.
- CPython: `3.14.7`, python-build-standalone build `20260929`, asset `cpython-3.14.7+20260929-<triple>-install_only_stripped.tar.gz`, SHA-256 pinned below, installed with `uv python install 3.14.7 --install-dir <dir> --no-bin` and `UV_PYTHON_INSTALL_MIRROR=file://<verified mirror>`.
- Every download goes through `download()` from `server/features/operations/releases.js` (retries, idle timeout, proxy); nothing installs globally; the owner's `~/.npmrc`, `pip.conf`, `uv.toml` never apply (`UV_NO_CONFIG=1`, empty npmrc files).
- Error codes are stable `MCP_PACKAGE_*` strings; installer output reports codes only, never paths.
- Source and test files stay under 600 lines (`npm run check:structure`).
- Commits: English, `feat:`/`chore:`/`docs:` prefixes, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Documentation edits: `docs/installation.md` (English), `docs/linux.md` (still German: small edits stay German).

### Pinned values (fetched and checked on 2026-10-14)

| Target         | uv triple                   | uv 0.12.21 SHA-256                                                 | CPython 3.14.7+20260929 SHA-256                                    |
| -------------- | --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `darwin-arm64` | `aarch64-apple-darwin`      | `b88bda573e566ef9bced66b155fe0408626fbbc053aee1c30ba686f0728c9447` | `44b4716f4e63bc85e1c07ea2aca730d13a0ec3557d06526d84a13b1d111cf4f9` |
| `darwin-x64`   | `x86_64-apple-darwin`       | `2b336763b396ec6afa20c5a8b083538ca7402445b868311979d740a4344c17d8` | `419c8d110a393add7e20480f785a9cc2213978cdb10f8198ee7bb38b02cdb0fe` |
| `linux-arm64`  | `aarch64-unknown-linux-gnu` | `030b69227b40af8c1981b7301793dc66e71ed3c796ea8688209dd268bd91ec51` | `9b8bd45d06fc3fcdc56f2713a62535fe1c019816461ae87c170dd56184dd3f4d` |
| `linux-x64`    | `x86_64-unknown-linux-gnu`  | `23f02075b652bb1df64178cfae41b5caf160822e720e2663568f3f5d63bc52c0` | `da5357f47b1d9c8d4c439004d463d893ef688a44c27438a62b47073d26d1377e` |

Sources: the `.sha256` assets of the uv 0.12.21 GitHub release and `SHA256SUMS` of python-build-standalone release `20260929`. The `darwin-arm64` uv and CPython archives were downloaded and re-hashed locally; a local spike confirmed that `uv python install` with a `file://` mirror reads only the mirror (an empty mirror fails with "No such file or directory") and that a mirror path is `<mirror>/<build>/<asset>`.

## Review Focus

1. **Interrupted staging** (kill during download or `uv python install`): a later run must neither use nor trip over the half-written `.stage-*` directory; expect the next ensure to start a fresh stage and the stale one to be removed.
2. **Tampered installation** (a receipt edited, `bin/node` replaced by a link, extra hard link): `readToolchain` must refuse it with `MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE`, never return paths into it.
3. **Two concurrent ensures** (installer and first package install at once): one install runs, the other waits on the lock or reports `MCP_PACKAGE_BUSY`; never two stages renamed onto the same directory.
4. **Proxy-only network**: downloads use the proxy environment through `download()`; uv receives only the proxy variables plus its own, so the mirror install still works offline.
5. **Musl Linux or an unsupported architecture**: fails before any download with `MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE`; the installer still succeeds and reports the code.

---

## File Structure

| File                                                             | Responsibility                                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Create `server/features/mcp-packages/package-errors.js`          | `packageProblem(code, status)` with the German server message for each `MCP_PACKAGE_*` code. |
| Create `server/lib/i18n/de/mcp-packages.js`                      | German backend messages for the codes; registered in `server/lib/i18n/catalog-de.js`.        |
| Create `server/features/mcp-packages/toolchain-manifest.js`      | Pins: Node, uv, CPython per target; `toolchainTarget()` platform and libc check.             |
| Create `server/features/mcp-packages/verified-files.js`          | `sha256Matches()`, `regularFile()`, `privateFolder()` re-export for package code.            |
| Create `server/features/mcp-packages/toolchains.js`              | `toolchainPaths`, `ensureToolchain`, `readToolchain`, lock, staging, receipts.               |
| Create `server/features/mcp-packages/toolchain-provisioning.js`  | `provisionInstallerToolchains`, `toolchainStagingDue`, `stageToolchainsInBackground`.        |
| Modify `scripts/setup-resume.mjs`, `scripts/release-install.mjs` | Call the installer provisioning after the assistant runtime; report `toolchains`.            |
| Modify `server/app.js`                                           | Start the background stage once the server listens.                                          |
| Modify `server/http/responses.js`                                | Pass `MCP_PACKAGE_*` codes through to responses.                                             |
| Create `scripts/verify-mcp-toolchains.mjs`                       | Native qualification: provision into a temporary data dir and run each binary.               |
| Create `.github/workflows/mcp-toolchains.yml`                    | Runs the native qualification on all four targets (Linux on pull requests).                  |
| Create `tests/helpers/toolchain-fixture.js`                      | Builds fake Node/uv/CPython tarballs with executable shell scripts and a matching manifest.  |
| Create tests under `tests/unit/` and `tests/integration/`        | As named in each task.                                                                       |

---

### Task 1: Error codes and German messages

**Files:**

- Create: `server/lib/i18n/de/mcp-packages.js`
- Modify: `server/lib/i18n/catalog-de.js` (import next to `mcpServers`, line 33; add to the object next to line 55)
- Create: `server/features/mcp-packages/package-errors.js`
- Modify: `server/http/responses.js:50-52`
- Test: `tests/unit/mcp-package-errors.test.js`

**Interfaces:**

- Produces: `packageCodes` (array of the 14 codes), `packageProblem(code, status = 400)` → `Error` with `status`, `code`, German `message`; `serverMessages.mcpPackages[<camelKey>]`.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/mcp-package-errors.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  packageCodes,
  packageProblem,
} from "../../server/features/mcp-packages/package-errors.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

test("every package code has a German message and keeps its code and status", () => {
  assert.equal(packageCodes.length, 14);
  for (const code of packageCodes) {
    const error = packageProblem(code, 409);
    assert.equal(error.code, code);
    assert.equal(error.status, 409);
    assert.equal(typeof error.message, "string");
    assert.ok(error.message.length > 10, code);
  }
  assert.ok(serverMessages.mcpPackages.toolchainUnavailable.includes("Toolchain"));
});

test("an unknown code is a defect, not a silent generic message", () => {
  assert.throws(() => packageProblem("MCP_PACKAGE_NOPE"), /Unknown package code/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/mcp-package-errors.test.js`
Expected: FAIL with `Cannot find module …/package-errors.js`.

- [ ] **Step 3: Write the messages and the helper**

```js
// server/lib/i18n/de/mcp-packages.js
export const mcpPackages = {
  invalid:
    "Bitte ein Paket aus npm oder PyPI mit gültigem Namen und exakter Version angeben.",
  notFound: "Dieses Paket gibt es in der gewählten Registry nicht.",
  versionNotFound: "Diese Version des Pakets gibt es nicht.",
  registryUnavailable:
    "Die Registry ist gerade nicht erreichbar. Bitte später erneut versuchen.",
  needsScripts:
    "Das Paket braucht Installationsskripte oder einen Build aus dem Quellcode. Erlaube das ausdrücklich, um es zu installieren.",
  integrityMismatch: "Die Prüfsumme eines Pakets stimmt nicht mit der Registry überein.",
  foreignSource:
    "Eine Abhängigkeit stammt nicht aus der öffentlichen Registry und wird abgelehnt.",
  noProgram: "Das Paket enthält kein startbares Programm.",
  programRequired: "Das Paket enthält mehrere Programme. Bitte eines auswählen.",
  toolchainUnavailable:
    "Die Toolchain für dieses Paket lässt sich auf diesem Rechner nicht bereitstellen (nur macOS und Linux mit glibc, arm64 oder x64).",
  downloadFailed: "Der Download ist fehlgeschlagen. Bitte später erneut versuchen.",
  installFailed: "Die Installation ist fehlgeschlagen. Details stehen im Protokoll.",
  previewExpired: "Die Vorschau ist abgelaufen. Bitte die Installation erneut prüfen.",
  busy: "Für diesen Server läuft bereits eine Installation.",
};
```

```js
// server/features/mcp-packages/package-errors.js
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

const keys = {
  MCP_PACKAGE_INVALID: "invalid",
  MCP_PACKAGE_NOT_FOUND: "notFound",
  MCP_PACKAGE_VERSION_NOT_FOUND: "versionNotFound",
  MCP_PACKAGE_REGISTRY_UNAVAILABLE: "registryUnavailable",
  MCP_PACKAGE_NEEDS_SCRIPTS: "needsScripts",
  MCP_PACKAGE_INTEGRITY_MISMATCH: "integrityMismatch",
  MCP_PACKAGE_FOREIGN_SOURCE: "foreignSource",
  MCP_PACKAGE_NO_PROGRAM: "noProgram",
  MCP_PACKAGE_PROGRAM_REQUIRED: "programRequired",
  MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE: "toolchainUnavailable",
  MCP_PACKAGE_DOWNLOAD_FAILED: "downloadFailed",
  MCP_PACKAGE_INSTALL_FAILED: "installFailed",
  MCP_PACKAGE_PREVIEW_EXPIRED: "previewExpired",
  MCP_PACKAGE_BUSY: "busy",
};
export const packageCodes = Object.keys(keys);

/** A problem with a stable `MCP_PACKAGE_*` code; its message never carries a path. */
export function packageProblem(code, status = 400) {
  const key = keys[code];
  if (!key) throw Error(`Unknown package code ${code}`);
  return Object.assign(problem(serverMessages.mcpPackages[key], status), { code });
}

/** The stable code of `error`, else `fallback`: installer output can carry paths. */
export const packageCode = (error, fallback) =>
  packageCodes.includes(error?.code) ? error.code : fallback;
```

In `server/lib/i18n/catalog-de.js` add `import { mcpPackages } from "./de/mcp-packages.js";` after line 33 and `mcpPackages,` after `mcpServers,` (line 55). In `server/http/responses.js` change the code regex to `/^(?:SSH|ARTIFACT|PIPELINE|MCP_CLI|MCP_PACKAGE)_[A-Z_]+$/`.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/unit/mcp-package-errors.test.js tests/unit/server-i18n-catalogs.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/i18n/de/mcp-packages.js server/lib/i18n/catalog-de.js \
  server/features/mcp-packages/package-errors.js server/http/responses.js \
  tests/unit/mcp-package-errors.test.js
git commit -m "feat: add MCP package error codes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Toolchain manifest and platform check

**Files:**

- Create: `server/features/mcp-packages/toolchain-manifest.js`
- Test: `tests/unit/mcp-toolchain-manifest.test.js`

**Interfaces:**

- Consumes: `runtimeManifest` (`nodeVersion`, `npmVersion`, `nodeChecksums`).
- Produces: `toolchainManifest` `{ node: { version, npmVersion, checksums }, uv: { version, triples, checksums, url(target) }, python: { version, build, checksums, asset(target), url(target) } }`; `toolchainTarget({ platform, arch, glibc })` → `"darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64"`, else throws `MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE`; `hostGlibc()` → glibc version string or `null`.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/mcp-toolchain-manifest.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  toolchainManifest as m,
  toolchainTarget,
} from "../../server/features/mcp-packages/toolchain-manifest.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";

const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const sha = /^[0-9a-f]{64}$/;

test("every supported target pins Node, uv and CPython with a SHA-256", () => {
  assert.equal(m.node.version, runtimeManifest.nodeVersion);
  assert.equal(m.node.npmVersion, runtimeManifest.npmVersion);
  for (const target of targets) {
    assert.match(m.node.checksums[target], sha, `node ${target}`);
    assert.match(m.uv.checksums[target], sha, `uv ${target}`);
    assert.match(m.python.checksums[target], sha, `python ${target}`);
  }
  assert.deepEqual(Object.keys(m.uv.checksums).sort(), targets);
  assert.deepEqual(Object.keys(m.python.checksums).sort(), targets);
});

test("download URLs name the pinned versions and official hosts", () => {
  assert.equal(
    m.uv.url("linux-x64"),
    "https://github.com/astral-sh/uv/releases/download/0.12.21/uv-x86_64-unknown-linux-gnu.tar.gz",
  );
  assert.equal(
    m.python.asset("darwin-arm64"),
    "cpython-3.14.7+20260929-aarch64-apple-darwin-install_only_stripped.tar.gz",
  );
  assert.equal(
    m.python.url("darwin-arm64"),
    "https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.14.7%2B20260929-aarch64-apple-darwin-install_only_stripped.tar.gz",
  );
});

test("the target check refuses musl, Windows and unknown architectures", () => {
  assert.equal(toolchainTarget({ platform: "darwin", arch: "arm64" }), "darwin-arm64");
  assert.equal(
    toolchainTarget({ platform: "linux", arch: "x64", glibc: "2.39" }),
    "linux-x64",
  );
  for (const host of [
    { platform: "linux", arch: "x64", glibc: null },
    { platform: "win32", arch: "x64" },
    { platform: "linux", arch: "ppc64", glibc: "2.39" },
  ])
    assert.throws(
      () => toolchainTarget(host),
      (error) => error.code === "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE",
      JSON.stringify(host),
    );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/mcp-toolchain-manifest.test.js`
Expected: FAIL with `Cannot find module …/toolchain-manifest.js`.

- [ ] **Step 3: Write the manifest**

```js
// server/features/mcp-packages/toolchain-manifest.js
import { runtimeManifest } from "../assistants/runtime-manifest.js";
import { packageProblem } from "./package-errors.js";

// uv release assets (.sha256) and python-build-standalone SHA256SUMS, verified
// 2026-10-14. uv 0.12.21 (2026-09-29) instead of the two-day-old 0.13 line.
const triples = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
};
const uvVersion = "0.12.21";
const pythonVersion = "3.14.7";
const pythonBuild = "20260929";
const pythonAsset = (target) =>
  `cpython-${pythonVersion}+${pythonBuild}-${triples[target]}-install_only_stripped.tar.gz`;

export const toolchainManifest = Object.freeze({
  node: {
    version: runtimeManifest.nodeVersion,
    npmVersion: runtimeManifest.npmVersion,
    checksums: runtimeManifest.nodeChecksums,
  },
  uv: {
    version: uvVersion,
    triples,
    checksums: {
      "darwin-arm64": "b88bda573e566ef9bced66b155fe0408626fbbc053aee1c30ba686f0728c9447",
      "darwin-x64": "2b336763b396ec6afa20c5a8b083538ca7402445b868311979d740a4344c17d8",
      "linux-arm64": "030b69227b40af8c1981b7301793dc66e71ed3c796ea8688209dd268bd91ec51",
      "linux-x64": "23f02075b652bb1df64178cfae41b5caf160822e720e2663568f3f5d63bc52c0",
    },
    url: (target) =>
      `https://github.com/astral-sh/uv/releases/download/${uvVersion}/uv-${triples[target]}.tar.gz`,
  },
  python: {
    version: pythonVersion,
    build: pythonBuild,
    checksums: {
      "darwin-arm64": "44b4716f4e63bc85e1c07ea2aca730d13a0ec3557d06526d84a13b1d111cf4f9",
      "darwin-x64": "419c8d110a393add7e20480f785a9cc2213978cdb10f8198ee7bb38b02cdb0fe",
      "linux-arm64": "9b8bd45d06fc3fcdc56f2713a62535fe1c019816461ae87c170dd56184dd3f4d",
      "linux-x64": "da5357f47b1d9c8d4c439004d463d893ef688a44c27438a62b47073d26d1377e",
    },
    asset: pythonAsset,
    url: (target) =>
      `https://github.com/astral-sh/python-build-standalone/releases/download/${pythonBuild}/${encodeURIComponent(pythonAsset(target))}`,
  },
});

/** The glibc version of this process, or null on musl and non-Linux hosts. */
export function hostGlibc() {
  try {
    return process.report.getReport().header.glibcVersionRuntime ?? null;
  } catch {
    return null;
  }
}

/** `<platform>-<arch>` when every toolchain is pinned for it; never for musl. */
export function toolchainTarget({
  platform = process.platform,
  arch = process.arch,
  glibc = platform === "linux" ? hostGlibc() : null,
} = {}) {
  const target = `${platform}-${arch}`;
  if (!triples[target] || (platform === "linux" && !glibc))
    throw packageProblem("MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE", 503);
  return target;
}
```

Note: `encodeURIComponent("+")` yields `%2B`, matching the test URL.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/mcp-toolchain-manifest.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-packages/toolchain-manifest.js tests/unit/mcp-toolchain-manifest.test.js
git commit -m "feat: pin Node, uv and CPython toolchains for MCP packages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Toolchain fixture and verified file helpers

**Files:**

- Create: `server/features/mcp-packages/verified-files.js`
- Create: `tests/helpers/toolchain-fixture.js`
- Test: `tests/unit/mcp-verified-files.test.js`

**Interfaces:**

- Produces: `sha256Matches(bytes, expected)` → boolean; `regularFile(file)` throws `MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE` unless a regular, non-linked file with `nlink === 1`; `privateFolder` (re-export from `assistants/runtime-paths.js`).
- Produces (test helper): `toolchainFixture(t, { target = "darwin-arm64" })` → `{ dataDir, manifest, download, downloads }` where `manifest` has the fixture checksums, `download(url)` serves the fixture bytes by URL and records calls in `downloads`.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/mcp-verified-files.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  regularFile,
  sha256Matches,
} from "../../server/features/mcp-packages/verified-files.js";

test("sha256Matches compares hex digests exactly", () => {
  const bytes = Buffer.from("abc");
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256Matches(bytes, digest), true);
  assert.equal(sha256Matches(bytes, digest.toUpperCase()), false);
  assert.equal(sha256Matches(Buffer.from("abd"), digest), false);
});

test("regularFile refuses links and hard-linked files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verified-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "bin");
  fs.writeFileSync(file, "x");
  assert.doesNotThrow(() => regularFile(file));
  fs.symlinkSync(file, path.join(dir, "link"));
  assert.throws(() => regularFile(path.join(dir, "link")), {
    code: "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE",
  });
  fs.linkSync(file, path.join(dir, "hard"));
  assert.throws(() => regularFile(file), { code: "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/mcp-verified-files.test.js`
Expected: FAIL with `Cannot find module …/verified-files.js`.

- [ ] **Step 3: Implement helpers and the fixture**

```js
// server/features/mcp-packages/verified-files.js
import fs from "node:fs";
import { createHash } from "node:crypto";
import { packageProblem } from "./package-errors.js";
export { privateFolder } from "../assistants/runtime-paths.js";

export const sha256Matches = (bytes, expected) =>
  createHash("sha256").update(bytes).digest("hex") === expected;

/** A regular file that no link or second name can redirect. */
export function regularFile(file, code = "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE") {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw packageProblem(code, 503);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw packageProblem(code, 503);
  return file;
}
```

```js
// tests/helpers/toolchain-fixture.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { toolchainManifest } from "../../server/features/mcp-packages/toolchain-manifest.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function script(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
function tarball(root, name) {
  return execFileSync("tar", ["-czf", "-", "-C", root, name]);
}

/**
 * Fake Node, uv and CPython archives whose programs are shell scripts, plus a
 * manifest pinning their checksums. The fake uv installs a fake CPython only from
 * the `file://` mirror AgentPier prepared, as the real one does.
 */
export function toolchainFixture(t, { target = "darwin-arm64" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-toolchains-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const source = path.join(root, "source");
  fs.mkdirSync(dataDir);
  const m = toolchainManifest;
  const nodeName = `node-v${m.node.version}-${target}`;
  script(path.join(source, nodeName, "bin/node"), `echo v${m.node.version}`);
  fs.mkdirSync(path.join(source, nodeName, "lib/node_modules/npm/bin"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(source, nodeName, "lib/node_modules/npm/package.json"),
    JSON.stringify({ version: m.node.npmVersion }),
  );
  fs.writeFileSync(
    path.join(source, nodeName, "lib/node_modules/npm/bin/npm-cli.js"),
    "",
  );
  const uvName = `uv-${m.uv.triples[target]}`;
  const asset = m.python.asset(target);
  script(
    path.join(source, uvName, "uv"),
    [
      `if [ "$1" = "--version" ]; then echo "uv ${m.uv.version} (fixture)"; exit 0; fi`,
      `if [ "$1" = "python" ] && [ "$2" = "install" ]; then`,
      `  [ -f "\${UV_PYTHON_INSTALL_MIRROR#file://}/${m.python.build}/${asset}" ] || exit 3`,
      `  dir="$5/cpython-$3-fixture/bin"; mkdir -p "$dir"`,
      `  printf '#!/bin/sh\\necho "Python %s"\\n' "$3" > "$dir/python3"; chmod +x "$dir/python3"`,
      `  exit 0`,
      `fi`,
      `exit 2`,
    ].join("\n"),
  );
  const bytes = {
    node: tarball(source, nodeName),
    uv: tarball(source, uvName),
    python: Buffer.from("fixture cpython archive"),
  };
  const manifest = {
    ...m,
    node: { ...m.node, checksums: { ...m.node.checksums, [target]: sha(bytes.node) } },
    uv: { ...m.uv, checksums: { ...m.uv.checksums, [target]: sha(bytes.uv) } },
    python: {
      ...m.python,
      checksums: { ...m.python.checksums, [target]: sha(bytes.python) },
    },
  };
  const byUrl = new Map([
    [`https://nodejs.org/dist/v${m.node.version}/${nodeName}.tar.gz`, bytes.node],
    [m.uv.url(target), bytes.uv],
    [m.python.url(target), bytes.python],
  ]);
  const downloads = [];
  const download = async (url) => {
    downloads.push(url);
    if (!byUrl.has(url)) throw Object.assign(Error("404"), { status: 404 });
    return byUrl.get(url);
  };
  return { root, dataDir, manifest, download, downloads, bytes, target };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/mcp-verified-files.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-packages/verified-files.js tests/helpers/toolchain-fixture.js \
  tests/unit/mcp-verified-files.test.js
git commit -m "feat: add verified file helpers and a toolchain fixture

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Install and read toolchains

**Files:**

- Create: `server/features/mcp-packages/toolchains.js`
- Test: `tests/unit/mcp-toolchains.test.js`

**Interfaces:**

- Consumes: `toolchainManifest`, `toolchainTarget`, `sha256Matches`, `regularFile`, `privateFolder`, `download` (`operations/releases.js`), `withInstallLock` (`assistants/runtime-install-lock.js`, which only reads `paths.runtimes`), `proxyEnvironment` (`server/lib/proxy-environment.js`), `packageProblem`.
- Produces (used by plans 2 and 3 exactly as written):
  - `toolchainPaths(dataDir)` → `{ root }` where `root = <dataDir>/toolchains` (created 0700).
  - `nodeDirectory(dataDir, target, manifest)` → `<root>/node-v26.7.0-<target>`; `pythonDirectory(dataDir, target, manifest)` → `<root>/python-3.14.7+20260929-uv0.12.21-<target>`.
  - `ensureToolchain(kind, options)` with `kind: "node" | "python"` and `options = { dataDir, platform?, arch?, glibc?, download?, execute?, manifest?, environment? }` → Node descriptor `{ kind: "node", version, directory, nodePath, npmCliPath }` or Python descriptor `{ kind: "python", directory, uvPath, uvVersion, pythonVersion, pythonPath }`.
  - `readToolchain(kind, options)` → the same descriptor from a verified receipt, or `null` when not installed; throws `MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE` when present but tampered.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/mcp-toolchains.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { toolchainFixture } from "../helpers/toolchain-fixture.js";
import {
  ensureToolchain,
  readToolchain,
} from "../../server/features/mcp-packages/toolchains.js";

const options = (f, extra = {}) => ({
  dataDir: f.dataDir,
  platform: "darwin",
  arch: "arm64",
  download: f.download,
  manifest: f.manifest,
  ...extra,
});

test("node toolchain installs once, verifies and is read back without downloads", async (t) => {
  const f = toolchainFixture(t);
  const node = await ensureToolchain("node", options(f));
  assert.equal(node.kind, "node");
  assert.equal(execFileSync(node.nodePath).toString().trim(), "v26.7.0");
  assert.ok(node.npmCliPath.endsWith("lib/node_modules/npm/bin/npm-cli.js"));
  assert.deepEqual(readToolchain("node", options(f)), node);
  const again = await ensureToolchain("node", options(f));
  assert.deepEqual(again, node);
  assert.equal(f.downloads.length, 1);
  assert.deepEqual(
    fs.readdirSync(path.dirname(node.directory)).filter((n) => n.startsWith(".stage")),
    [],
  );
});

test("python toolchain installs CPython only from the verified mirror", async (t) => {
  const f = toolchainFixture(t);
  const python = await ensureToolchain("python", options(f));
  assert.equal(python.uvVersion, "0.12.21");
  assert.equal(python.pythonVersion, "3.14.7");
  assert.equal(execFileSync(python.pythonPath).toString().trim(), "Python 3.14.7");
  assert.equal(fs.existsSync(path.join(python.directory, "mirror")), false);
  assert.deepEqual(readToolchain("python", options(f)), python);
});

test("a corrupt download leaves nothing behind and keeps the code stable", async (t) => {
  const f = toolchainFixture(t);
  const corrupt = async () => Buffer.from("corrupt");
  await assert.rejects(ensureToolchain("node", options(f, { download: corrupt })), {
    code: "MCP_PACKAGE_DOWNLOAD_FAILED",
  });
  assert.equal(readToolchain("node", options(f)), null);
  assert.deepEqual(fs.readdirSync(path.join(f.dataDir, "toolchains")), []);
});

test("an unreachable download reports MCP_PACKAGE_DOWNLOAD_FAILED", async (t) => {
  const f = toolchainFixture(t);
  const offline = async () => {
    throw Object.assign(Error("offline"), { status: 502 });
  };
  await assert.rejects(ensureToolchain("python", options(f, { download: offline })), {
    code: "MCP_PACKAGE_DOWNLOAD_FAILED",
  });
});

test("a tampered installation is refused, not used", async (t) => {
  const f = toolchainFixture(t);
  const node = await ensureToolchain("node", options(f));
  fs.rmSync(node.nodePath);
  fs.symlinkSync("/bin/sh", node.nodePath);
  assert.throws(() => readToolchain("node", options(f)), {
    code: "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE",
  });
});

test("musl hosts fail before any download", async (t) => {
  const f = toolchainFixture(t);
  await assert.rejects(
    ensureToolchain("node", options(f, { platform: "linux", arch: "x64", glibc: null })),
    { code: "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE" },
  );
  assert.equal(f.downloads.length, 0);
});

test("a stale stage from an interrupted run is removed by the next install", async (t) => {
  const f = toolchainFixture(t);
  const stale = path.join(f.dataDir, "toolchains", ".stage-stale");
  fs.mkdirSync(stale, { recursive: true });
  await ensureToolchain("node", options(f));
  assert.equal(fs.existsSync(stale), false);
});

test("concurrent ensures of one kind install once", async (t) => {
  const f = toolchainFixture(t);
  const [a, b] = await Promise.all([
    ensureToolchain("node", options(f)),
    ensureToolchain("node", options(f)),
  ]);
  assert.deepEqual(a, b);
  assert.equal(f.downloads.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/mcp-toolchains.test.js`
Expected: FAIL with `Cannot find module …/toolchains.js`.

- [ ] **Step 3: Implement `toolchains.js`**

```js
// server/features/mcp-packages/toolchains.js
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { download as fetchDownload } from "../operations/releases.js";
import { withInstallLock } from "../assistants/runtime-install-lock.js";
import { proxyEnvironment } from "../../lib/proxy-environment.js";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { packageProblem } from "./package-errors.js";
import { toolchainManifest, toolchainTarget } from "./toolchain-manifest.js";
import { privateFolder, regularFile, sha256Matches } from "./verified-files.js";

const executeFile = promisify(execFile);
const downloadFile = (url) => fetchDownload(url, fetch, 256 * 1024 * 1024);
const jobs = new Map();
const unavailable = () => packageProblem("MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE", 503);

export function toolchainPaths(dataDir) {
  return { root: privateFolder(path.join(dataDir, "toolchains")) };
}
export const nodeDirectory = (dataDir, target, m = toolchainManifest) =>
  path.join(dataDir, "toolchains", `node-v${m.node.version}-${target}`);
export const pythonDirectory = (dataDir, target, m = toolchainManifest) =>
  path.join(
    dataDir,
    "toolchains",
    `python-${m.python.version}+${m.python.build}-uv${m.uv.version}-${target}`,
  );

async function fetchVerified(url, expected, download) {
  let bytes;
  try {
    bytes = await download(url);
  } catch {
    throw packageProblem("MCP_PACKAGE_DOWNLOAD_FAILED", 502);
  }
  if (!sha256Matches(bytes, expected))
    throw packageProblem("MCP_PACKAGE_DOWNLOAD_FAILED", 502);
  return bytes;
}
async function extract(bytes, into, execute) {
  const archive = `${into}.tar.gz`;
  fs.writeFileSync(archive, bytes, { mode: 0o600 });
  try {
    privateFolder(into);
    await execute("tar", ["-xzf", archive, "-C", into, "--strip-components=1"], {
      timeout: 120000,
      maxBuffer: 65536,
    });
  } finally {
    fs.rmSync(archive, { force: true });
  }
}
/** Only proxy settings are inherited; HOME, TMPDIR and caches stay private. */
function isolated(stage, environment) {
  for (const name of ["home", "tmp", "cache"]) privateFolder(path.join(stage, name));
  return {
    ...proxyEnvironment(environment),
    HOME: path.join(stage, "home"),
    TMPDIR: path.join(stage, "tmp"),
    PATH: `/usr/bin${path.delimiter}/bin`,
    UV_NO_CONFIG: "1",
    UV_CACHE_DIR: path.join(stage, "cache"),
    UV_PYTHON_DOWNLOADS: "manual",
  };
}

function nodeDescriptor(directory, m) {
  return {
    kind: "node",
    version: m.node.version,
    directory,
    nodePath: path.join(directory, "bin", "node"),
    npmCliPath: path.join(directory, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  };
}
function pythonDescriptor(directory, receipt) {
  return {
    kind: "python",
    directory,
    uvPath: path.join(directory, "uv", "uv"),
    uvVersion: receipt.uvVersion,
    pythonVersion: receipt.pythonVersion,
    pythonPath: path.join(directory, receipt.pythonPath),
  };
}

async function installNode({ stage, target, m, download, execute }) {
  const name = `node-v${m.node.version}-${target}`;
  const bytes = await fetchVerified(
    `https://nodejs.org/dist/v${m.node.version}/${name}.tar.gz`,
    m.node.checksums[target],
    download,
  );
  const directory = path.join(stage, "node");
  await extract(bytes, directory, execute);
  const node = regularFile(path.join(directory, "bin", "node"));
  const npm = readJSON(path.join(directory, "lib/node_modules/npm/package.json"), {});
  if (npm.version !== m.node.npmVersion) throw unavailable();
  const { stdout } = await execute(node, ["--version"], { timeout: 30000 });
  if (stdout.trim() !== `v${m.node.version}`) throw unavailable();
  return { content: directory, receipt: { checksum: m.node.checksums[target] } };
}

async function installPython({ stage, target, m, download, execute, environment }) {
  const uvBytes = await fetchVerified(m.uv.url(target), m.uv.checksums[target], download);
  const content = privateFolder(path.join(stage, "python"));
  const uvDirectory = path.join(content, "uv");
  await extract(uvBytes, uvDirectory, execute);
  const uv = regularFile(path.join(uvDirectory, "uv"));
  const env = isolated(stage, environment);
  const version = await execute(uv, ["--version"], { env, timeout: 30000 });
  if (!version.stdout.startsWith(`uv ${m.uv.version}`)) throw unavailable();
  const archive = await fetchVerified(
    m.python.url(target),
    m.python.checksums[target],
    download,
  );
  // uv reads `<mirror>/<build>/<asset>`; only this verified file is in the mirror.
  const mirror = privateFolder(path.join(stage, "mirror", m.python.build));
  fs.writeFileSync(path.join(mirror, m.python.asset(target)), archive, { mode: 0o600 });
  const pythonRoot = path.join(content, "cpython");
  try {
    await execute(
      uv,
      ["python", "install", m.python.version, "--install-dir", pythonRoot, "--no-bin"],
      {
        env: {
          ...env,
          UV_PYTHON_INSTALL_MIRROR: `file://${path.join(stage, "mirror")}`,
        },
        timeout: 300000,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch {
    throw packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502);
  }
  const installed = fs
    .readdirSync(pythonRoot)
    .find((name) => name.startsWith(`cpython-${m.python.version}-`));
  if (!installed) throw unavailable();
  const relative = path.join("cpython", installed, "bin", "python3");
  const python = path.join(content, relative);
  const reported = await execute(python, ["--version"], { env, timeout: 30000 });
  if (reported.stdout.trim() !== `Python ${m.python.version}`) throw unavailable();
  return {
    content,
    receipt: {
      uvChecksum: m.uv.checksums[target],
      pythonChecksum: m.python.checksums[target],
      uvVersion: m.uv.version,
      pythonVersion: m.python.version,
      pythonPath: relative,
    },
  };
}

function directoryOf(kind, dataDir, target, m) {
  return kind === "node"
    ? nodeDirectory(dataDir, target, m)
    : pythonDirectory(dataDir, target, m);
}

/** The installed toolchain from its verified receipt; null when none is installed. */
export function readToolchain(
  kind,
  { dataDir, platform, arch, glibc, manifest: m = toolchainManifest } = {},
) {
  const target = toolchainTarget({ platform, arch, glibc });
  const directory = directoryOf(kind, dataDir, target, m);
  const receiptFile = path.join(directory, "receipt.json");
  if (!fs.existsSync(receiptFile)) return null;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  regularFile(receiptFile);
  const receipt = readJSON(receiptFile, {});
  if (kind === "node") {
    if (receipt.kind !== "node" || receipt.checksum !== m.node.checksums[target])
      throw unavailable();
    const descriptor = nodeDescriptor(directory, m);
    regularFile(descriptor.nodePath);
    regularFile(descriptor.npmCliPath);
    return descriptor;
  }
  if (
    receipt.kind !== "python" ||
    receipt.uvChecksum !== m.uv.checksums[target] ||
    receipt.pythonChecksum !== m.python.checksums[target] ||
    path.isAbsolute(receipt.pythonPath) ||
    receipt.pythonPath.split(path.sep).includes("..")
  )
    throw unavailable();
  const descriptor = pythonDescriptor(directory, receipt);
  regularFile(descriptor.uvPath);
  // CPython's bin/python3 is a link to python3.x inside the same install.
  const real = fs.realpathSync(descriptor.pythonPath);
  if (!real.startsWith(fs.realpathSync(directory) + path.sep)) throw unavailable();
  return descriptor;
}

async function install(kind, options) {
  const {
    dataDir,
    platform,
    arch,
    glibc,
    download = downloadFile,
    execute = executeFile,
    manifest: m = toolchainManifest,
    environment = process.env,
  } = options;
  const target = toolchainTarget({ platform, arch, glibc });
  const { root } = toolchainPaths(dataDir);
  return locked(root, async () => {
    const existing = readToolchain(kind, { ...options, manifest: m });
    if (existing) return existing;
    for (const name of fs.readdirSync(root))
      if (name.startsWith(".stage-"))
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
    const stage = privateFolder(path.join(root, `.stage-${randomUUID()}`));
    try {
      const work = kind === "node" ? installNode : installPython;
      const { content, receipt } = await work({
        stage,
        target,
        m,
        download,
        execute,
        environment,
      });
      writePrivate(path.join(content, "receipt.json"), { kind, target, ...receipt });
      fs.renameSync(content, directoryOf(kind, dataDir, target, m));
      return readToolchain(kind, { ...options, manifest: m });
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });
}

/** The shared pid/start-time lock (`<root>/.install.lock`); busy → MCP_PACKAGE_BUSY. */
async function locked(root, operation) {
  try {
    return await withInstallLock({ runtimes: root }, operation);
  } catch (error) {
    if (error?.code === "RUNTIME_BUSY") throw packageProblem("MCP_PACKAGE_BUSY", 409);
    throw error;
  }
}

/** Installs the pinned toolchain once; concurrent callers share one job. */
export function ensureToolchain(kind, options) {
  if (kind !== "node" && kind !== "python") throw unavailable();
  const key = `${path.resolve(options.dataDir)}:${kind}`;
  if (jobs.has(key)) return jobs.get(key);
  const job = Promise.resolve()
    .then(() => install(kind, options))
    .finally(() => jobs.delete(key));
  jobs.set(key, job);
  return job;
}
```

Notes for the implementer:

- `withInstallLock({ runtimes: root }, …)` reuses the runtime's lock; it only reads `paths.runtimes`, and its busy error carries `code: "RUNTIME_BUSY"` (`runtime-install-lock.js:10`).
- `pythonPath` is relative in the receipt so a moved data directory stays readable.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/mcp-toolchains.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-packages/toolchains.js tests/unit/mcp-toolchains.test.js
git commit -m "feat: install verified Node and Python toolchains for MCP packages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Installer and update-path provisioning

**Files:**

- Create: `server/features/mcp-packages/toolchain-provisioning.js`
- Modify: `scripts/setup-resume.mjs` (dependency list near line 88; call after line 207; result near line 257)
- Modify: `scripts/release-install.mjs` (dependency list near line 40; call after line 73; result near line 100)
- Modify: `server/app.js` (next to the `server.once("listening", …)` calls, lines 152–162)
- Test: `tests/unit/mcp-toolchain-provisioning.test.js`, extend `tests/integration/setup-entrypoint.test.js` only if it asserts the exact result keys (check with `grep -n "assistantRuntime" tests/integration/setup-entrypoint.test.js`; add `toolchains` where the result object is compared).

**Interfaces:**

- Consumes: `ensureToolchain`, `toolchainPaths`, `toolchainTarget`, `packageCode`.
- Produces:
  - `provisionInstallerToolchains({ dataDir }, { ensure = ensureToolchain } = {})` → `{ node: { status: "ready", version } | { status: "failed", code }, python: { status: "ready", version } | { status: "failed", code } }`; never throws.
  - `toolchainStagingDue(dataDir, manifest?)` → `{ node: boolean, python: boolean }`: true for a kind whose older version directory exists while the current one does not.
  - `stageToolchainsInBackground({ dataDir }, { ensure } = {})` → `Promise<null | object>`; never rejects; logs only a code.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/mcp-toolchain-provisioning.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  provisionInstallerToolchains,
  stageToolchainsInBackground,
  toolchainStagingDue,
} from "../../server/features/mcp-packages/toolchain-provisioning.js";

const dataDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolchain-provision-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("installer provisioning reports each toolchain and never throws", async (t) => {
  const calls = [];
  const result = await provisionInstallerToolchains(
    { dataDir: dataDir(t) },
    {
      ensure: async (kind) => {
        calls.push(kind);
        if (kind === "python")
          throw Object.assign(Error("/private/path"), {
            code: "MCP_PACKAGE_DOWNLOAD_FAILED",
          });
        return { kind, version: "26.7.0" };
      },
    },
  );
  assert.deepEqual(calls, ["node", "python"]);
  assert.deepEqual(result, {
    node: { status: "ready", version: "26.7.0" },
    python: { status: "failed", code: "MCP_PACKAGE_DOWNLOAD_FAILED" },
  });
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("an unexpected error is reported with a generic code", async (t) => {
  const result = await provisionInstallerToolchains(
    { dataDir: dataDir(t) },
    { ensure: async () => Promise.reject(Error("EACCES /secret")) },
  );
  assert.equal(result.node.code, "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE");
});

test("background staging runs only for kinds with an older toolchain", async (t) => {
  const dir = dataDir(t);
  assert.deepEqual(toolchainStagingDue(dir), { node: false, python: false });
  assert.equal(await stageToolchainsInBackground({ dataDir: dir }), null);
  fs.mkdirSync(path.join(dir, "toolchains", "node-v26.1.0-darwin-arm64"), {
    recursive: true,
  });
  const due = toolchainStagingDue(dir, undefined, { platform: "darwin", arch: "arm64" });
  assert.deepEqual(due, { node: true, python: false });
  const staged = [];
  await stageToolchainsInBackground(
    { dataDir: dir, platform: "darwin", arch: "arm64" },
    { ensure: async (kind) => staged.push(kind) },
  );
  assert.deepEqual(staged, ["node"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/mcp-toolchain-provisioning.test.js`
Expected: FAIL with `Cannot find module …/toolchain-provisioning.js`.

- [ ] **Step 3: Implement provisioning and wire it**

```js
// server/features/mcp-packages/toolchain-provisioning.js
import fs from "node:fs";
import path from "node:path";
import { packageCode } from "./package-errors.js";
import { toolchainManifest, toolchainTarget } from "./toolchain-manifest.js";
import { ensureToolchain, nodeDirectory, pythonDirectory } from "./toolchains.js";

const kinds = ["node", "python"];
const fallback = "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE";

/** Installer step: never fails the AgentPier installation; reports codes only. */
export async function provisionInstallerToolchains(
  { dataDir, platform, arch },
  { ensure = ensureToolchain } = {},
) {
  const result = {};
  for (const kind of kinds) {
    try {
      const toolchain = await ensure(kind, { dataDir, platform, arch });
      result[kind] = {
        status: "ready",
        version: toolchain.version ?? toolchain.pythonVersion,
      };
    } catch (error) {
      result[kind] = { status: "failed", code: packageCode(error, fallback) };
    }
  }
  return result;
}

/** Which kinds an update should prepare: an older one exists, the current not. */
export function toolchainStagingDue(
  dataDir,
  m = toolchainManifest,
  { platform, arch, glibc } = {},
) {
  const due = { node: false, python: false };
  const root = path.join(dataDir, "toolchains");
  let names;
  let target;
  try {
    names = fs.readdirSync(root);
    target = toolchainTarget({ platform, arch, glibc });
  } catch {
    return due;
  }
  const current = {
    node: path.basename(nodeDirectory(dataDir, target, m)),
    python: path.basename(pythonDirectory(dataDir, target, m)),
  };
  for (const kind of kinds)
    due[kind] =
      !names.includes(current[kind]) &&
      names.some((name) => name.startsWith(`${kind}-`) && name.endsWith(`-${target}`));
  return due;
}

/** After an update: prepares new pins without blocking start; never rejects. */
export function stageToolchainsInBackground(
  { dataDir, platform, arch },
  { ensure = ensureToolchain } = {},
) {
  const due = toolchainStagingDue(dataDir, undefined, { platform, arch });
  const wanted = kinds.filter((kind) => due[kind]);
  if (!wanted.length) return Promise.resolve(null);
  return new Promise((resolve) => setImmediate(resolve)).then(async () => {
    for (const kind of wanted)
      try {
        await ensure(kind, { dataDir, platform, arch });
      } catch (error) {
        console.error(
          `AgentPier could not prepare the ${kind} toolchain: ${packageCode(error, fallback)}`,
        );
      }
    return { staged: wanted };
  });
}
```

Wiring:

- `scripts/setup-resume.mjs`: import `provisionInstallerToolchains` from `../server/features/mcp-packages/toolchain-provisioning.js`; add `toolchains = provisionInstallerToolchains,` to the injected dependencies next to `assistantRuntime,` (line 88); right after the `provisionInstallerRuntime(...)` call (line 204–207) add `const toolchainResult = await toolchains({ dataDir });`; in the returned object next to `assistantRuntime` (line 257) add `toolchains: toolchainResult,`.
- `scripts/release-install.mjs`: the same three edits at lines 40, 70–73 and 100.
- `server/app.js`: import `stageToolchainsInBackground` and add `server.once("listening", () => stageToolchainsInBackground({ dataDir: config.dataDir }));` next to line 153.

- [ ] **Step 4: Run tests**

Run: `node --test tests/unit/mcp-toolchain-provisioning.test.js tests/integration/setup-entrypoint.test.js tests/integration/setup-recovery.test.js tests/integration/setup-review-regressions.test.js`
Expected: PASS. If a setup test compares the full result and fails on the new `toolchains` key, inject `toolchains: async () => ({})` in that test's dependencies (same place it injects `assistantRuntime`) so it never downloads, and expect `toolchains: {}`.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-packages/toolchain-provisioning.js scripts/setup-resume.mjs \
  scripts/release-install.mjs server/app.js tests/unit/mcp-toolchain-provisioning.test.js tests/integration
git commit -m "feat: provision MCP package toolchains in the installer and after updates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Native qualification, CI workflow and docs

**Files:**

- Create: `scripts/verify-mcp-toolchains.mjs`
- Create: `.github/workflows/mcp-toolchains.yml`
- Modify: `docs/installation.md` (new subsection after "Managed assistant runtime", line 277)
- Modify: `docs/linux.md` (German, after "### Optional assistants", line 143)

**Interfaces:**

- Consumes: `ensureToolchain`.
- Produces: `node scripts/verify-mcp-toolchains.mjs` exits 0 after printing `node v26.7.0`, `uv 0.12.21`, `Python 3.14.7` and creating and removing a relocatable venv.

- [ ] **Step 1: Write the qualification script**

```js
// scripts/verify-mcp-toolchains.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isMainModule } from "../server/lib/is-main-module.js";
import { ensureToolchain } from "../server/features/mcp-packages/toolchains.js";

/** Provisions both toolchains into a disposable data dir and runs each binary. */
export async function verifyMcpToolchains() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-toolchains-native-"));
  try {
    const node = await ensureToolchain("node", { dataDir });
    console.log(`node ${execFileSync(node.nodePath, ["--version"]).toString().trim()}`);
    const python = await ensureToolchain("python", { dataDir });
    const env = { PATH: "/usr/bin:/bin", HOME: dataDir, UV_NO_CONFIG: "1" };
    console.log(execFileSync(python.uvPath, ["--version"], { env }).toString().trim());
    console.log(execFileSync(python.pythonPath, ["--version"]).toString().trim());
    const venv = path.join(dataDir, "venv");
    execFileSync(
      python.uvPath,
      ["venv", "--relocatable", "--python", python.pythonPath, venv],
      { env: { ...env, UV_PYTHON_DOWNLOADS: "never" } },
    );
    console.log(
      execFileSync(path.join(venv, "bin", "python"), ["-I", "-c", "print('venv ok')"])
        .toString()
        .trim(),
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
if (isMainModule(import.meta.url)) await verifyMcpToolchains();
```

- [ ] **Step 2: Run it natively**

Run: `node scripts/verify-mcp-toolchains.mjs`
Expected output (macOS arm64):

```text
node v26.7.0
uv 0.12.21 (7af826859 2026-09-29 aarch64-apple-darwin)
Python 3.14.7
venv ok
```

- [ ] **Step 3: Add the workflow**

```yaml
# .github/workflows/mcp-toolchains.yml
name: MCP toolchains
# Pins checked against the real downloads on every target. Pull requests run Linux.
on:
  workflow_dispatch:
  workflow_call:
  push:
    branches: [main]
    paths:
      - ".github/workflows/mcp-toolchains.yml"
      - "server/features/mcp-packages/toolchain*"
      - "server/features/mcp-packages/verified-files.js"
      - "scripts/verify-mcp-toolchains.mjs"
  pull_request:
    paths:
      - ".github/workflows/mcp-toolchains.yml"
      - "server/features/mcp-packages/toolchain*"
      - "server/features/mcp-packages/verified-files.js"
      - "scripts/verify-mcp-toolchains.mjs"
permissions:
  contents: read
concurrency:
  group: mcp-toolchains-${{ github.event.pull_request.number && format('pr-{0}', github.event.pull_request.number) || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
jobs:
  native:
    name: Native toolchains (${{ matrix.target }})
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        include: >-
          ${{ fromJSON(github.event_name == 'pull_request'
          && '[{"runner":"ubuntu-24.04","target":"linux-x64"},{"runner":"ubuntu-24.04-arm","target":"linux-arm64"}]'
          || '[{"runner":"ubuntu-24.04","target":"linux-x64"},{"runner":"ubuntu-24.04-arm","target":"linux-arm64"},{"runner":"macos-15","target":"darwin-arm64"},{"runner":"macos-15-intel","target":"darwin-x64"}]') }}
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: node scripts/verify-mcp-toolchains.mjs
```

Also add `uses: ./.github/workflows/mcp-toolchains.yml` to `full.yml` next to the existing `assistant-runtime.yml` call (find it with `grep -n "assistant-runtime.yml" .github/workflows/full.yml` and copy that job block, renaming it `mcp-toolchains`).

- [ ] **Step 4: Update the docs**

`docs/installation.md`, new subsection after "Managed assistant runtime":

```markdown
### Toolchains for MCP server packages

AgentPier installs MCP server packages from npm and PyPI with its own pinned
toolchains under the data directory's `toolchains/` directory: Node 26.7.0 with npm
11.19.0, uv 0.12.21 and CPython 3.14.7 (python-build-standalone 20260929). They are
separate from the agents' OpenClaw runtime and need no agents. Every archive is
checked against a SHA-256 pinned in AgentPier before it is unpacked; CPython is
installed by the pinned uv only from the archive AgentPier verified. Nothing is
installed globally, and your own npm, pip or uv configuration is never read.

The installer provisions both toolchains; a failed download never fails the
installation (the result reports `toolchains.<kind>.status: "failed"` with a code),
and the first package install retries. After an AgentPier update with new pins, the
new toolchains are prepared in the background. Supported: macOS and Linux (glibc) on
arm64 and x64; other hosts report `MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE`.
```

`docs/linux.md`, after the "Optional assistants" paragraph:

```markdown
### Toolchains für MCP-Pakete

Für MCP-Serverpakete aus npm und PyPI stellt AgentPier eigene, per SHA-256 geprüfte
Toolchains (Node, uv, CPython) unter `toolchains/` im Datenverzeichnis bereit. Unter
Linux wird glibc vorausgesetzt; auf musl-Systemen (z. B. Alpine) meldet AgentPier
`MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE`. Details: [installation](installation.md#toolchains-for-mcp-server-packages).
```

- [ ] **Step 5: Verify everything and commit**

Run: `npm run format && npm run lint && npm run check:structure && node --test tests/unit/mcp-*.test.js`
Expected: all pass.

```bash
git add scripts/verify-mcp-toolchains.mjs .github/workflows/mcp-toolchains.yml \
  .github/workflows/full.yml docs/installation.md docs/linux.md
git commit -m "chore: qualify MCP package toolchains natively and document them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Full check and plan cleanup

**Files:**

- Delete: `docs/superpowers/plans/2026-10-14-mcp-packages-1-toolchains.md`

- [ ] **Step 1: Run the full check**

Run: `npm run check`
Expected: lint, format, structure, build and tests pass (the known environment-dependent Unicode login-shell test in `tests/integration/shell.test.js` may fail locally; note it in the PR if it does).

- [ ] **Step 2: Delete this plan (AGENTS.md: plans are working documents) and commit**

```bash
git rm docs/superpowers/plans/2026-10-14-mcp-packages-1-toolchains.md
git commit -m "chore: remove the completed toolchain plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The spec stays until plan 3 completes. The PR description lists `docs/installation.md` and `docs/linux.md` as updated docs and the native workflow results.
