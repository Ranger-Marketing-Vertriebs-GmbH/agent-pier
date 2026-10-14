# MCP Packages 2/3: npm Packages End to End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can create a stdio MCP server whose source is an npm package at an exact version; AgentPier previews, installs it from a frozen lock with the managed Node toolchain, generates the command, binds it to agents and coding CLIs like any server, and offers update with a lock diff, reinstall from the stored lock and removal.

**Architecture:** Pure helpers (`package-spec`, `registry-metadata`, `lock-check`, `program-select`) feed an npm installer that runs the managed npm in an isolated stage. A `package-store` owns `<data>/mcp-packages/installs/<installId>/` with receipts; `package-records` keeps one row per packaged server (including the lock text) in the existing MCP server database, so backups carry it. `McpPackages` orchestrates previews, background jobs and the switch of a server's command through the existing `CentralMcpChanges.update` path, so agents apply live and CLIs reconcile exactly as for hand-entered servers. Compilers skip a packaged server until its install is ready.

**Tech Stack:** Node.js ES modules, Express routes, `node:sqlite` via `privateDatabase`, React 18 JSX, `node:test`, fast-check, Playwright (Chromium, WebKit).

**Spec:** `docs/superpowers/specs/2026-10-14-mcp-package-install-design.md` (all sections except PyPI specifics).

## Global Constraints

- Depends on plan 1 (merged on `main`, `server/features/mcp-packages/`): `ensureToolchain("node", { dataDir })` → `{ kind: "node", version, directory, nodePath, npmCliPath }` (`directory` = `<data>/toolchains/node-v<version>-<target>`, not realpath'd); `readToolchain(kind, { dataDir })`; `toolchainRoot(dataDir)` → `<data>/toolchains`; async `pruneToolchains(dataDir, inUse)` (serialized with toolchain installs; any `inUse` entry outside `toolchainRoot(dataDir)` disables the whole prune, so callers pass only `<root>/<folder>` paths); `toolchainTarget()` (throws `MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE` on an unsupported host); `packageProblem(code, status = 400, messageKey?)` (throws on an unknown code); `packageCode(error, fallback)`; `regularFile(file, code?)`; `privateFolder(dir)`. Plan 2 adds the code `MCP_PACKAGE_CONFIRMATION_REQUIRED` (Task 10); `MCP_PACKAGE_INSTALL_REQUIRED` is a browser-only question code and never a server code.
- Registries: only `https://registry.npmjs.org` in production. Tests inject a local registry URL; the production default must never be overridable from a request.
- Exact versions only; no ranges, tags, URLs, `git+`, `file:` or paths.
- Install without opt-in: `npm ci --ignore-scripts`; with `allowScripts: true`: `npm ci` (scripts run). Resolution always `npm install --package-lock-only --ignore-scripts`.
- npm isolation: empty user/global npmrc, private `HOME`/`TMPDIR`, `npm_config_cache=<data>/mcp-packages/.npm-cache`, `PATH=<node bin>:/usr/bin:/bin`, `proxyEnvironment(process.env)`, `--registry=<registry>`, `--no-audit --no-fund`.
- Statuses of a package record: `installing`, `ready`, `failed`; the computed status also reports `missing` when a `ready` record's install fails its receipt check. Only `ready` is compiled for agents and CLIs.
- One owner confirmation per install (`confirmInstall: true` replaces `confirmStdio` for that save).
- Audit details: registry, name, version, `allowScripts`; never env values, args or paths.
- UI copy: German and English in `web/lib/i18n/{de,en,messages}/mcp-packages.js` with matching keys; run the catalog parity tests and exercise the UI in English. Server messages: every new key goes into both `server/lib/i18n/de/` and `server/lib/i18n/en/` (`tests/unit/server-i18n-catalogs.test.js` enforces parity).
- `node:sqlite` refuses `undefined` as a bound value: anything written to a column is a value or `null`, never `undefined`.
- Owner decisions carried from plan 1: **D1** an existing own-command stdio server can switch to a package (Tasks 8–11); **D2** toolchains no record and no running job uses are pruned (Tasks 8–9).
- Files ≤ 600 lines. `server/features/mcp-servers/mcp-server-store.js` is 574 lines today: Task 1 moves its pure helpers out before anything is added (≈ 515 lines after Task 1, ≈ 530 after Task 6). `mcp-packages.js` lands at ≈ 400 lines; if it passes 450, move `install`/`activate`/`switchCommand` into `package-install-job.js`.
- Commits: English, `feat:`/`fix:`/`chore:`/`docs:`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **AgentPier restarts during a first install:** the record stays `installing` with no job. Expect `start()` to mark it `failed` with `MCP_PACKAGE_INSTALL_FAILED` and the UI to offer **Reinstall** (test in Task 9).
2. **The owner edits the server (name, env, args) while an install job runs:** the job's switch hits a revision conflict. Expect one retry with the fresh revision, owner args preserved, no lost edit (test in Task 9).
3. **A restored backup on a new machine:** records exist, install directories do not. Expect computed status `missing`, the server skipped by the compilers, and **Reinstall** to install from the stored lock without a new resolution or confirmation (test in Task 9 and Task 11).
4. **A package whose `bin` path escapes its directory** (`"bin": "../../x"`) or points to a missing file: refused with `MCP_PACKAGE_NO_PROGRAM`, never a command outside the install (test in Task 4).
5. **A lock with a dependency from a tarball URL or another registry:** refused with `MCP_PACKAGE_FOREIGN_SOURCE` before `npm ci` runs (test in Task 3).
6. **The first install reaches the CLIs and agents without another save:** the record is written in the server's create transaction (`installing`) and set to `ready` before the command switch, so the reconciliation and the agents' apply that the switch triggers already see it ready (tests in Tasks 6 and 9).
7. **Toolchain pruning never disables itself and never removes a toolchain in use:** paths are kept by folder name under `<data>/toolchains`, so a stored real path (`/private/var` vs `/var`) or a foreign path cannot turn pruning off (test in Task 9).

---

## File Structure

| File                                                                                                                                                                                                                                                                                              | Responsibility                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Create `server/features/mcp-servers/mcp-server-fields.js`                                                                                                                                                                                                                                         | Pure field helpers moved from the store (`publicUrl`, `cleanAuth`, `cleanArgs`, `cleanCwd`, `splitMap`, `invalid`, `target`).                   |
| Modify `server/features/mcp-servers/mcp-server-store.js`                                                                                                                                                                                                                                          | Imports the helpers; `create(..., { pendingCommand, packageRecord })`; package fields in `publicServer()` and `definitions()`.                  |
| Create `server/features/mcp-packages/package-spec.js`                                                                                                                                                                                                                                             | Validate `{ registry, name, version }`.                                                                                                         |
| Create `server/features/mcp-packages/registry-metadata.js`                                                                                                                                                                                                                                        | npm packument → versions list, version info.                                                                                                    |
| Create `server/features/mcp-packages/lock-check.js`                                                                                                                                                                                                                                               | npm lock validation, digest, dependency list, diff.                                                                                             |
| Create `server/features/mcp-packages/program-select.js`                                                                                                                                                                                                                                           | npm `bin` → programs; choose one.                                                                                                               |
| Create `server/features/mcp-packages/npm-package-install.js`                                                                                                                                                                                                                                      | Resolve and install with the managed npm.                                                                                                       |
| Create `server/features/mcp-packages/package-store.js`                                                                                                                                                                                                                                            | Install directories, receipts, commit, prune, command generation.                                                                               |
| Create `server/features/mcp-packages/package-records.js`                                                                                                                                                                                                                                          | `server_packages` table on the MCP server database.                                                                                             |
| Create `server/features/mcp-packages/install-jobs.js`                                                                                                                                                                                                                                             | Per-server background jobs with status and redacted log tail.                                                                                   |
| Create `server/features/mcp-packages/mcp-packages.js`                                                                                                                                                                                                                                             | Service: versions, preview, create, attach, update, reinstall, detach, status, start, prune (installs and toolchains).                          |
| Create `server/http/routes/mcp-packages.js`                                                                                                                                                                                                                                                       | `/mcp-packages/versions`, `/mcp-packages/preview`, `/mcp-servers/:id/package*`, the `source` change of `PUT /mcp-servers/:id` (attach, detach). |
| Modify `server/http/routes/mcp-servers.js`, `server/application/services.js`, `server/app.js`                                                                                                                                                                                                     | Delegation and wiring.                                                                                                                          |
| Modify `server/features/mcp-packages/package-errors.js`, `server/lib/i18n/{de,en}/mcp-packages.js`, `server/lib/i18n/{de,en}/mcp-servers.js`                                                                                                                                                      | `MCP_PACKAGE_CONFIRMATION_REQUIRED`; `cliReasonPackage`.                                                                                        |
| Modify `server/features/mcp-servers/central-changes.js`, `server/features/assistants/mcp-changes.js`                                                                                                                                                                                              | Pass `pendingCommand` and `packageRecord` through `create`.                                                                                     |
| Modify `server/features/assistants/openclaw-config/mcp-servers.js`, `server/features/mcp-servers/cli-reconciler.js`, `cli-status.js`, `cli-grants.js`, `cli-bindings.js`                                                                                                                          | Skip non-ready packages; read grants for managed directories.                                                                                   |
| Modify `server/features/operations/mcp-server-backup.js`                                                                                                                                                                                                                                          | Known columns for `server_packages`.                                                                                                            |
| Create `web/lib/i18n/{de,en,messages}/mcp-packages.js`; modify `web/lib/i18n/{de,en}/mcp-cli.js`                                                                                                                                                                                                  | Copy.                                                                                                                                           |
| Modify `web/features/assistants/assistant-api.js`                                                                                                                                                                                                                                                 | API methods.                                                                                                                                    |
| Modify `web/features/mcp-servers/mcp-server-draft.js`, `mcp-server-save.js`, `McpServerFields.jsx`, `McpServerDetail.jsx`                                                                                                                                                                         | Source switch, preview confirmation, status panel.                                                                                              |
| Create `web/features/mcp-servers/McpPackageFields.jsx`, `McpPackageConfirmation.jsx`, `McpPackagePanel.jsx`, `useMcpPackageVersions.js`                                                                                                                                                           | Package UI.                                                                                                                                     |
| Create `tests/helpers/npm-registry-fixture.js`                                                                                                                                                                                                                                                    | Local npm registry serving packuments and tarballs.                                                                                             |
| Create tests: `tests/unit/mcp-package-{spec,records,compile,cli-status,store}.test.js`, `tests/unit/mcp-{registry-metadata,lock-check,program-select,install-jobs}.test.js`, `tests/integration/mcp-{npm-install,packages-service,packages-routes}.test.js`, `tests/browser/mcp-packages.spec.js` | Coverage per task.                                                                                                                              |
| Docs: `docs/mcp.md`, `docs/AGENTS.md`, `docs/sandbox.md`                                                                                                                                                                                                                                          | Behaviour and limits.                                                                                                                           |

---

### Task 1: Make room in the MCP server store

**Files:**

- Create: `server/features/mcp-servers/mcp-server-fields.js`
- Modify: `server/features/mcp-servers/mcp-server-store.js:38-108`
- Test: existing `tests/unit/mcp-server-store.test.js`, `tests/unit/mcp-server-store-cli.test.js`, `tests/unit/mcp-server-oauth-record.test.js`, `tests/integration/mcp-server-backup-hashes.test.js`

**Interfaces:**

- Produces: `mcp-server-fields.js` exports `publicUrl`, `cleanAuth`, `invalid`, `target`, `targetKinds`, `cleanArgs`, `cleanCwd`, `splitMap`, `messages`; `mcp-server-store.js` keeps exporting `publicUrl` (re-export) because `operations/mcp-server-backup.js:8` imports it from the store.

- [ ] **Step 1: Move the helpers verbatim**

Cut lines 38–108 of `mcp-server-store.js` (from the `publicUrl` JSDoc through `splitMap`) plus the `messages` and `targetKinds` constants into `mcp-server-fields.js`, exporting each function and both constants. Keep `transports`, `schema` and `logoutHistoryLimit` in the store. The new file starts with the imports the moved code needs:

```js
// server/features/mcp-servers/mcp-server-fields.js
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { record, values } from "../extensions/mcp-config.js";
import { clis } from "./cli-native.js";

export const messages = serverMessages.mcpServers;
export const targetKinds = ["agent", "cli"];
```

The store still uses `targetKinds` (`bindingsByTarget`), `invalid`, `target`, `messages`, `cleanArgs`, `cleanCwd`, `cleanAuth`, `splitMap`, `record`, `mcpUrl`, `problem` and `path`; it no longer uses `values` or `clis`. Replace its imports so lint finds nothing unused:

```js
import { randomUUID } from "node:crypto";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { privateDatabase } from "../../lib/private-database.js";
import { problem } from "../../lib/storage.js";
import { mcpUrl, record } from "../extensions/mcp-config.js";
import { CliEntryStore } from "./cli-entry-store.js";
import { resolveCommand, sanitisedPrefix } from "./command-resolution.js";
import {
  cleanArgs,
  cleanAuth,
  cleanCwd,
  invalid,
  messages,
  publicUrl,
  splitMap,
  target,
  targetKinds,
} from "./mcp-server-fields.js";
import { changedValues, requireLiteralValues } from "./value-references.js";
export { publicUrl } from "./mcp-server-fields.js";
```

The store calls `publicUrl` in `publicServer`, hence the import beside the re-export (a re-export alone binds no local name). Delete the store's own `const messages = …` and `const targetKinds = …` lines.

- [ ] **Step 2: Run the existing tests (pure refactor)**

Run: `node --test tests/unit/mcp-server-store.test.js tests/unit/mcp-server-store-cli.test.js tests/unit/mcp-server-oauth-record.test.js tests/integration/mcp-server-backup-hashes.test.js && npx eslint server/features/mcp-servers/mcp-server-store.js server/features/mcp-servers/mcp-server-fields.js && wc -l server/features/mcp-servers/mcp-server-store.js`
Expected: PASS, no lint findings; the store is about 515 lines (well below 600).

- [ ] **Step 3: Commit**

```bash
git add server/features/mcp-servers/mcp-server-fields.js server/features/mcp-servers/mcp-server-store.js
git commit -m "chore: move MCP server field helpers out of the store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Package references and npm registry metadata

**Files:**

- Create: `server/features/mcp-packages/package-spec.js`
- Create: `server/features/mcp-packages/registry-metadata.js`
- Test: `tests/unit/mcp-package-spec.test.js`, `tests/unit/mcp-registry-metadata.test.js`

**Interfaces:**

- Produces:
  - `registries` = `["npm"]` (plan 3 appends `"pypi"`).
  - `packageRef(input)` → `{ registry, name, version }` or throws `MCP_PACKAGE_INVALID` (400).
  - `packageName({ registry, name })` → validated name (for the versions endpoint, no version).
  - `npmRegistry` = `"https://registry.npmjs.org"`.
  - `fetchRegistryJson(url, { download })` → parsed JSON; 404 → `MCP_PACKAGE_NOT_FOUND`; other failures → `MCP_PACKAGE_REGISTRY_UNAVAILABLE` (502).
  - `npmVersions(packument)` → `{ latest, versions: [{ version, publishedAt, prerelease, deprecated }] }` newest first.
  - `npmVersionInfo(packument, version)` → `{ integrity, bin, installScripts }`; unknown version → `MCP_PACKAGE_VERSION_NOT_FOUND` (404).
  - `npmPackument(name, { registry = npmRegistry, download })` → packument JSON (URL `<registry>/<name with "/" encoded as "%2F">`).

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/mcp-package-spec.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { packageRef } from "../../server/features/mcp-packages/package-spec.js";

test("npm references need a valid name and an exact version", () => {
  assert.deepEqual(
    packageRef({ registry: "npm", name: "@scope/server-x", version: "1.2.3-beta.1" }),
    { registry: "npm", name: "@scope/server-x", version: "1.2.3-beta.1" },
  );
  for (const bad of [
    { registry: "npm", name: "Upper", version: "1.0.0" },
    { registry: "npm", name: "ok", version: "^1.0.0" },
    { registry: "npm", name: "ok", version: "latest" },
    { registry: "npm", name: "git+https://x/y", version: "1.0.0" },
    { registry: "npm", name: "file:../x", version: "1.0.0" },
    { registry: "npm", name: "../x", version: "1.0.0" },
    { registry: "npm", name: "ok", version: "1.0.0 || 2.0.0" },
    { registry: "cargo", name: "ok", version: "1.0.0" },
    { registry: "npm", name: "a".repeat(215), version: "1.0.0" },
  ])
    assert.throws(
      () => packageRef(bad),
      { code: "MCP_PACKAGE_INVALID" },
      JSON.stringify(bad),
    );
});

test("no accepted npm name contains a path or URL separator sequence", () => {
  fc.assert(
    fc.property(fc.string(), (name) => {
      try {
        const ref = packageRef({ registry: "npm", name, version: "1.0.0" });
        // `a..b` is a valid npm name; only a whole `..` segment would escape.
        return (
          !ref.name.split("/").includes("..") &&
          !ref.name.includes(":") &&
          !/\s/.test(ref.name)
        );
      } catch (error) {
        return error.code === "MCP_PACKAGE_INVALID";
      }
    }),
  );
});
```

```js
// tests/unit/mcp-registry-metadata.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchRegistryJson,
  npmVersionInfo,
  npmVersions,
} from "../../server/features/mcp-packages/registry-metadata.js";

const packument = {
  "dist-tags": { latest: "1.1.0" },
  time: {
    created: "2026-01-01T00:00:00.000Z",
    "1.0.0": "2026-01-02T00:00:00.000Z",
    "1.1.0": "2026-03-01T00:00:00.000Z",
    "2.0.0-rc.1": "2026-04-01T00:00:00.000Z",
  },
  versions: {
    "1.0.0": { dist: { integrity: "sha512-a" }, bin: "dist/index.js", deprecated: "old" },
    "1.1.0": {
      dist: { integrity: "sha512-b" },
      bin: { "server-x": "dist/index.js" },
      scripts: { postinstall: "node x" },
    },
    "2.0.0-rc.1": { dist: { integrity: "sha512-c" } },
  },
};

test("versions are newest first with prerelease and deprecated markers", () => {
  assert.deepEqual(npmVersions(packument), {
    latest: "1.1.0",
    versions: [
      {
        version: "2.0.0-rc.1",
        publishedAt: "2026-04-01T00:00:00.000Z",
        prerelease: true,
        deprecated: false,
      },
      {
        version: "1.1.0",
        publishedAt: "2026-03-01T00:00:00.000Z",
        prerelease: false,
        deprecated: false,
      },
      {
        version: "1.0.0",
        publishedAt: "2026-01-02T00:00:00.000Z",
        prerelease: false,
        deprecated: true,
      },
    ],
  });
});

test("version info carries integrity, bin and install scripts", () => {
  assert.deepEqual(npmVersionInfo(packument, "1.1.0"), {
    integrity: "sha512-b",
    bin: { "server-x": "dist/index.js" },
    installScripts: true,
  });
  assert.throws(() => npmVersionInfo(packument, "9.9.9"), {
    code: "MCP_PACKAGE_VERSION_NOT_FOUND",
  });
});

test("registry failures map to stable codes", async () => {
  const fail = (status) => async () => {
    throw Object.assign(Error("x"), { status });
  };
  await assert.rejects(fetchRegistryJson("https://r/x", { download: fail(404) }), {
    code: "MCP_PACKAGE_NOT_FOUND",
  });
  await assert.rejects(fetchRegistryJson("https://r/x", { download: fail(502) }), {
    code: "MCP_PACKAGE_REGISTRY_UNAVAILABLE",
  });
  await assert.rejects(
    fetchRegistryJson("https://r/x", { download: async () => Buffer.from("{") }),
    { code: "MCP_PACKAGE_REGISTRY_UNAVAILABLE" },
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/mcp-package-spec.test.js tests/unit/mcp-registry-metadata.test.js`
Expected: FAIL with missing modules.

- [ ] **Step 3: Implement**

```js
// server/features/mcp-packages/package-spec.js
import { packageProblem } from "./package-errors.js";

export const registries = ["npm"];
const invalid = () => packageProblem("MCP_PACKAGE_INVALID", 400);
// npm's rules: lowercase, URL-safe, optional @scope/, at most 214 characters.
const npmName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
// An exact semantic version; no range, tag or build alias.
const npmVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const names = { npm: (name) => name.length <= 214 && npmName.test(name) };
const versions = { npm: (version) => version.length <= 256 && npmVersion.test(version) };

export function packageName({ registry, name } = {}) {
  if (!registries.includes(registry) || typeof name !== "string") throw invalid();
  if (!names[registry](name)) throw invalid();
  return name;
}

export function packageRef(input = {}) {
  const name = packageName(input);
  const { registry, version } = input;
  if (typeof version !== "string" || !versions[registry](version)) throw invalid();
  return { registry, name, version };
}
```

```js
// server/features/mcp-packages/registry-metadata.js
import { download as fetchDownload } from "../operations/releases.js";
import { packageProblem } from "./package-errors.js";

export const npmRegistry = "https://registry.npmjs.org";
const metadataLimit = 64 * 1024 * 1024;
const defaultDownload = (url) =>
  fetchDownload(url, fetch, metadataLimit, { headers: { accept: "application/json" } });

export async function fetchRegistryJson(url, { download = defaultDownload } = {}) {
  let bytes;
  try {
    bytes = await download(url);
  } catch (error) {
    throw error?.status === 404
      ? packageProblem("MCP_PACKAGE_NOT_FOUND", 404)
      : packageProblem("MCP_PACKAGE_REGISTRY_UNAVAILABLE", 502);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw packageProblem("MCP_PACKAGE_REGISTRY_UNAVAILABLE", 502);
  }
}

export const npmPackument = (name, { registry = npmRegistry, download } = {}) =>
  fetchRegistryJson(`${registry}/${name.replace("/", "%2F")}`, { download });

export function npmVersions(packument) {
  const time = packument?.time || {};
  const versions = Object.entries(packument?.versions || {})
    .map(([version, info]) => ({
      version,
      publishedAt: typeof time[version] === "string" ? time[version] : null,
      prerelease: version.includes("-"),
      deprecated: !!info?.deprecated,
    }))
    .sort(
      (a, b) =>
        String(b.publishedAt).localeCompare(String(a.publishedAt)) ||
        b.version.localeCompare(a.version),
    );
  return { latest: packument?.["dist-tags"]?.latest ?? null, versions };
}

const installHooks = ["preinstall", "install", "postinstall"];
export function npmVersionInfo(packument, version) {
  const info = packument?.versions?.[version];
  if (!info) throw packageProblem("MCP_PACKAGE_VERSION_NOT_FOUND", 404);
  return {
    integrity: info.dist?.integrity ?? null,
    bin: info.bin ?? null,
    installScripts: installHooks.some((hook) => typeof info.scripts?.[hook] === "string"),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/mcp-package-spec.test.js tests/unit/mcp-registry-metadata.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-packages/package-spec.js server/features/mcp-packages/registry-metadata.js \
  tests/unit/mcp-package-spec.test.js tests/unit/mcp-registry-metadata.test.js
git commit -m "feat: validate npm package references and read registry metadata

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: npm lock check and diff

**Files:**

- Create: `server/features/mcp-packages/lock-check.js`
- Test: `tests/unit/mcp-lock-check.test.js`

**Interfaces:**

- Produces:
  - `lockDigest(text)` → SHA-256 hex.
  - `checkNpmLock(text, { ref, integrity, registry })` → `{ digest, dependencies: [{ name, version }], needsScripts }`, sorted by name; throws `MCP_PACKAGE_INSTALL_FAILED` (malformed), `MCP_PACKAGE_FOREIGN_SOURCE`, `MCP_PACKAGE_INTEGRITY_MISMATCH`.
  - `lockDiff(before, after)` (dependency arrays) → `{ added: [{ name, version }], removed: [{ name, version }], changed: [{ name, from, to }] }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/mcp-lock-check.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { checkNpmLock, lockDiff } from "../../server/features/mcp-packages/lock-check.js";

const registry = "https://registry.npmjs.org";
const ref = { registry: "npm", name: "server-x", version: "1.1.0" };
const entry = (name, version, extra = {}) => ({
  version,
  resolved: `${registry}/${name}/-/${name}-${version}.tgz`,
  integrity: `sha512-${name}`,
  ...extra,
});
const lock = (packages) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "server-x": "1.1.0" } },
      "node_modules/server-x": entry("server-x", "1.1.0"),
      ...packages,
    },
  });

test("a registry-only lock yields its dependencies and digest", () => {
  const text = lock({ "node_modules/zod": entry("zod", "3.0.0") });
  const result = checkNpmLock(text, { ref, integrity: "sha512-server-x", registry });
  assert.equal(result.needsScripts, false);
  assert.deepEqual(result.dependencies, [
    { name: "server-x", version: "1.1.0" },
    { name: "zod", version: "3.0.0" },
  ]);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
});

test("install scripts anywhere in the graph are reported", () => {
  const text = lock({
    "node_modules/esbuild": entry("esbuild", "0.1.0", { hasInstallScript: true }),
  });
  assert.equal(
    checkNpmLock(text, { ref, integrity: "sha512-server-x", registry }).needsScripts,
    true,
  );
});

test("foreign sources, links and missing hashes are refused", () => {
  for (const extra of [
    {
      "node_modules/a": {
        version: "1.0.0",
        resolved: "https://evil.example/a.tgz",
        integrity: "sha512-a",
      },
    },
    {
      "node_modules/a": { version: "1.0.0", resolved: "git+https://github.com/a/a.git" },
    },
    { "node_modules/a": { link: true, resolved: "../a" } },
    { "node_modules/a": { version: "1.0.0", resolved: `${registry}/a/-/a-1.0.0.tgz` } },
    { "../outside": entry("a", "1.0.0") },
  ])
    assert.throws(
      () => checkNpmLock(lock(extra), { ref, integrity: "sha512-server-x", registry }),
      { code: "MCP_PACKAGE_FOREIGN_SOURCE" },
      JSON.stringify(extra),
    );
});

test("bundled children are accepted only under a hashed parent", () => {
  const ok = lock({
    "node_modules/server-x/node_modules/inner": { version: "1.0.0", inBundle: true },
  });
  assert.doesNotThrow(() =>
    checkNpmLock(ok, { ref, integrity: "sha512-server-x", registry }),
  );
});

test("a top-level integrity that differs from the registry is refused", () => {
  assert.throws(
    () => checkNpmLock(lock({}), { ref, integrity: "sha512-other", registry }),
    {
      code: "MCP_PACKAGE_INTEGRITY_MISMATCH",
    },
  );
  assert.throws(
    () =>
      checkNpmLock(lock({}), {
        ref: { ...ref, version: "2.0.0" },
        integrity: "sha512-server-x",
        registry,
      }),
    { code: "MCP_PACKAGE_INTEGRITY_MISMATCH" },
  );
});

test("lockDiff lists added, removed and changed packages", () => {
  assert.deepEqual(
    lockDiff(
      [
        { name: "a", version: "1.0.0" },
        { name: "b", version: "1.0.0" },
      ],
      [
        { name: "a", version: "1.1.0" },
        { name: "c", version: "2.0.0" },
      ],
    ),
    {
      added: [{ name: "c", version: "2.0.0" }],
      removed: [{ name: "b", version: "1.0.0" }],
      changed: [{ name: "a", from: "1.0.0", to: "1.1.0" }],
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/mcp-lock-check.test.js`
Expected: FAIL with missing module.

- [ ] **Step 3: Implement**

```js
// server/features/mcp-packages/lock-check.js
import { createHash } from "node:crypto";
import { packageProblem } from "./package-errors.js";

export const lockDigest = (text) => createHash("sha256").update(text).digest("hex");
const foreign = () => packageProblem("MCP_PACKAGE_FOREIGN_SOURCE", 400);
const nameOf = (key) =>
  key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);

/**
 * Validates an npm lockfileVersion 3 resolved by AgentPier: every package comes from
 * `registry` with a sha512 hash, except bundled children inside a hashed parent;
 * the top-level package matches the reference and the registry's integrity.
 */
export function checkNpmLock(text, { ref, integrity, registry }) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    throw packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502);
  }
  if (lock?.lockfileVersion !== 3 || typeof lock.packages !== "object")
    throw packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502);
  const prefix = `${registry}/`;
  const hashed = new Set();
  const dependencies = [];
  let needsScripts = false;
  const keys = Object.keys(lock.packages)
    .filter((key) => key !== "")
    .sort((a, b) => a.length - b.length);
  for (const key of keys) {
    const entry = lock.packages[key];
    if (!key.startsWith("node_modules/") || key.split("/").includes(".."))
      throw foreign();
    if (entry.link) throw foreign();
    if (entry.hasInstallScript) needsScripts = true;
    if (entry.inBundle) {
      const parent = [...hashed].some((owner) =>
        key.startsWith(`${owner}/node_modules/`),
      );
      if (!parent || entry.resolved) throw foreign();
    } else {
      if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(prefix))
        throw foreign();
      if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-"))
        throw foreign();
      hashed.add(key);
    }
    dependencies.push({ name: nameOf(key), version: String(entry.version) });
  }
  const top = lock.packages[`node_modules/${ref.name}`];
  if (!top || top.version !== ref.version || top.integrity !== integrity)
    throw packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
  dependencies.sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  return { digest: lockDigest(text), dependencies, needsScripts };
}

export function lockDiff(before = [], after = []) {
  const map = (list) => new Map(list.map((d) => [d.name, d.version]));
  const old = map(before);
  const next = map(after);
  const added = after.filter((d) => !old.has(d.name));
  const removed = before.filter((d) => !next.has(d.name));
  const changed = after
    .filter((d) => old.has(d.name) && old.get(d.name) !== d.version)
    .map((d) => ({ name: d.name, from: old.get(d.name), to: d.version }));
  return { added, removed, changed };
}
```

Note: a package may appear at several nesting levels with different versions; `lockDiff` keys by name and keeps the last entry, which is enough for an owner-facing summary. The dependency count in the preview uses `dependencies.length` (all entries).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/mcp-lock-check.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-packages/lock-check.js tests/unit/mcp-lock-check.test.js
git commit -m "feat: check and diff npm locks of MCP server packages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Program selection and the install store

**Files:**

- Create: `server/features/mcp-packages/program-select.js`
- Create: `server/features/mcp-packages/package-store.js`
- Test: `tests/unit/mcp-program-select.test.js`, `tests/unit/mcp-package-store.test.js`

**Interfaces:**

- Produces:
  - `npmPrograms(name, bin)` → `[{ name, path }]` (relative POSIX path, no `..`, not absolute).
  - `chooseProgram(programs, wanted)` → `{ name, path }`; none → `MCP_PACKAGE_NO_PROGRAM`; several and `wanted` missing or unknown → `MCP_PACKAGE_PROGRAM_REQUIRED`.
  - `packageRoot(dataDir)` → `<data>/mcp-packages` (0700); `installDirectory(dataDir, installId)` → `<root>/installs/<installId>`.
  - `stageInstall(dataDir)` → `{ installId, stage }`.
  - `commitInstall(dataDir, { installId, stage, receipt })` → final directory.
  - `readInstall(dataDir, installId, digest)` → receipt or `null`.
  - `pruneInstalls(dataDir, keep: Set<string>)` removes every install and stage not in `keep`.
  - `npmCommand(dataDir, receipt, node)` → `{ command, leading: [absoluteProgram] }`; throws `MCP_PACKAGE_NO_PROGRAM` when the program escapes or is missing.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/mcp-program-select.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseProgram,
  npmPrograms,
} from "../../server/features/mcp-packages/program-select.js";

test("a string bin is named after the unscoped package", () => {
  assert.deepEqual(npmPrograms("@scope/server-x", "./dist/index.js"), [
    { name: "server-x", path: "dist/index.js" },
  ]);
});
test("escaping or absolute bin paths are dropped", () => {
  assert.deepEqual(npmPrograms("x", { a: "../../etc/x", b: "/bin/sh", c: "bin/c.js" }), [
    { name: "c", path: "bin/c.js" },
  ]);
});
test("choosing a program", () => {
  const two = [
    { name: "a", path: "a.js" },
    { name: "b", path: "b.js" },
  ];
  assert.deepEqual(chooseProgram([two[0]], undefined), two[0]);
  assert.deepEqual(chooseProgram(two, "b"), two[1]);
  assert.throws(() => chooseProgram(two, undefined), {
    code: "MCP_PACKAGE_PROGRAM_REQUIRED",
  });
  assert.throws(() => chooseProgram(two, "z"), { code: "MCP_PACKAGE_PROGRAM_REQUIRED" });
  assert.throws(() => chooseProgram([], undefined), { code: "MCP_PACKAGE_NO_PROGRAM" });
});
```

```js
// tests/unit/mcp-package-store.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commitInstall,
  npmCommand,
  pruneInstalls,
  readInstall,
  stageInstall,
} from "../../server/features/mcp-packages/package-store.js";

const dataDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-package-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const receipt = (extra = {}) => ({
  registry: "npm",
  name: "server-x",
  version: "1.1.0",
  lockDigest: "d".repeat(64),
  program: { name: "server-x", path: "dist/index.js" },
  ...extra,
});

test("a committed install is read back by its digest and pruned when unreferenced", (t) => {
  const dir = dataDir(t);
  const { installId, stage } = stageInstall(dir);
  fs.mkdirSync(path.join(stage, "node_modules/server-x/dist"), { recursive: true });
  fs.writeFileSync(path.join(stage, "node_modules/server-x/dist/index.js"), "");
  const final = commitInstall(dir, { installId, stage, receipt: receipt() });
  assert.equal(fs.existsSync(stage), false);
  assert.deepEqual(readInstall(dir, installId, "d".repeat(64)), receipt());
  assert.equal(readInstall(dir, installId, "e".repeat(64)), null);
  const node = { nodePath: "/managed/node" };
  assert.deepEqual(npmCommand(dir, { ...receipt(), installId }, node), {
    command: "/managed/node",
    leading: [path.join(final, "node_modules/server-x/dist/index.js")],
  });
  pruneInstalls(dir, new Set());
  assert.equal(fs.existsSync(final), false);
});

test("a program outside the install or missing is refused", (t) => {
  const dir = dataDir(t);
  const { installId, stage } = stageInstall(dir);
  commitInstall(dir, { installId, stage, receipt: receipt() });
  assert.throws(() => npmCommand(dir, { ...receipt(), installId }, { nodePath: "/n" }), {
    code: "MCP_PACKAGE_NO_PROGRAM",
  });
  fs.mkdirSync(path.join(dir, "outside"));
  fs.writeFileSync(path.join(dir, "outside/x.js"), "");
  fs.mkdirSync(
    path.join(dir, "mcp-packages/installs", installId, "node_modules/server-x"),
    {
      recursive: true,
    },
  );
  fs.symlinkSync(
    path.join(dir, "outside"),
    path.join(dir, "mcp-packages/installs", installId, "node_modules/server-x/dist"),
  );
  assert.throws(
    () =>
      npmCommand(
        dir,
        { ...receipt(), program: { name: "x", path: "dist/x.js" }, installId },
        { nodePath: "/n" },
      ),
    { code: "MCP_PACKAGE_NO_PROGRAM" },
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/mcp-program-select.test.js tests/unit/mcp-package-store.test.js`
Expected: FAIL with missing modules.

- [ ] **Step 3: Implement**

```js
// server/features/mcp-packages/program-select.js
import path from "node:path";
import { packageProblem } from "./package-errors.js";

const safe = (file) => {
  if (typeof file !== "string" || !file) return null;
  const normal = path.posix.normalize(file.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(normal) || normal.split("/").includes("..")) return null;
  return normal.replace(/^\.\//, "");
};

export function npmPrograms(name, bin) {
  const entries =
    typeof bin === "string" ? [[name.split("/").pop(), bin]] : Object.entries(bin || {});
  return entries
    .map(([program, file]) => ({ name: program, path: safe(file) }))
    .filter((program) => program.path && /^[A-Za-z0-9._-]{1,100}$/.test(program.name));
}

export function chooseProgram(programs, wanted) {
  if (!programs.length) throw packageProblem("MCP_PACKAGE_NO_PROGRAM", 400);
  if (programs.length === 1 && (wanted === undefined || wanted === programs[0].name))
    return programs[0];
  const chosen = programs.find((program) => program.name === wanted);
  if (!chosen) throw packageProblem("MCP_PACKAGE_PROGRAM_REQUIRED", 400);
  return chosen;
}
```

```js
// server/features/mcp-packages/package-store.js
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { packageProblem } from "./package-errors.js";
import { privateFolder, regularFile } from "./verified-files.js";

const idPattern = /^[0-9a-f-]{36}$/;
export const packageRoot = (dataDir) => privateFolder(path.join(dataDir, "mcp-packages"));
const installs = (dataDir) => privateFolder(path.join(packageRoot(dataDir), "installs"));
export function installDirectory(dataDir, installId) {
  if (!idPattern.test(installId)) throw packageProblem("MCP_PACKAGE_INSTALL_FAILED", 500);
  return path.join(dataDir, "mcp-packages", "installs", installId);
}
export function stageInstall(dataDir) {
  const installId = randomUUID();
  return {
    installId,
    stage: privateFolder(path.join(installs(dataDir), `.stage-${installId}`)),
  };
}
export function commitInstall(dataDir, { installId, stage, receipt }) {
  writePrivate(path.join(stage, "receipt.json"), receipt);
  const final = installDirectory(dataDir, installId);
  fs.renameSync(stage, final);
  return final;
}
/** The receipt of an install whose lock digest is `digest`, else null. */
export function readInstall(dataDir, installId, digest) {
  try {
    const directory = installDirectory(dataDir, installId);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const file = regularFile(
      path.join(directory, "receipt.json"),
      "MCP_PACKAGE_INSTALL_FAILED",
    );
    const receipt = readJSON(file, null);
    return receipt?.lockDigest === digest ? receipt : null;
  } catch {
    return null;
  }
}
export function pruneInstalls(dataDir, keep) {
  let names;
  try {
    names = fs.readdirSync(path.join(dataDir, "mcp-packages", "installs"));
  } catch {
    return;
  }
  for (const name of names) {
    const id = name.replace(/^\.stage-/, "");
    if (!keep.has(id))
      fs.rmSync(path.join(dataDir, "mcp-packages", "installs", name), {
        recursive: true,
        force: true,
      });
  }
}
/** The managed Node plus the program's absolute path, contained in the install. */
export function npmCommand(dataDir, receipt, node) {
  const directory = installDirectory(dataDir, receipt.installId);
  const packageDir = path.join(directory, "node_modules", ...receipt.name.split("/"));
  const program = path.join(packageDir, receipt.program.path);
  try {
    const real = fs.realpathSync(program);
    if (
      !real.startsWith(fs.realpathSync(directory) + path.sep) ||
      !fs.statSync(real).isFile()
    )
      throw Error("outside");
  } catch {
    throw packageProblem("MCP_PACKAGE_NO_PROGRAM", 502);
  }
  return { command: node.nodePath, leading: [program] };
}
```

Note: `pruneInstalls` must never remove the stage of a running job; `McpPackages` passes the running jobs' install ids in `keep` (Task 8).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/mcp-program-select.test.js tests/unit/mcp-package-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-packages/program-select.js server/features/mcp-packages/package-store.js \
  tests/unit/mcp-program-select.test.js tests/unit/mcp-package-store.test.js
git commit -m "feat: select package programs and keep verified installs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The npm installer against a local registry

**Files:**

- Create: `server/features/mcp-packages/npm-package-install.js`
- Create: `tests/helpers/npm-registry-fixture.js`
- Test: `tests/integration/mcp-npm-install.test.js`

**Interfaces:**

- Consumes: `checkNpmLock`, node descriptor `{ nodePath, npmCliPath }`.
- Produces:
  - `npmManifestText(ref)` → deterministic `package.json` text: `{"name":"agentpier-mcp-package","private":true,"dependencies":{"<name>":"<version>"}}\n`.
  - `resolveNpm({ stage, ref, node, registry, cacheDir, execute?, environment? })` → `{ manifestText, lockText }`.
  - `installNpm({ directory, manifestText, lockText, ref, node, registry, cacheDir, allowScripts, execute?, environment?, log? })` → void; verifies `node_modules/<name>/package.json` has `ref.version`; failures → `MCP_PACKAGE_INSTALL_FAILED`.
- Test helper `npmRegistryFixture(t, packages)` where `packages` is `[{ name, version, bin?, files?, scripts?, dependencies? }]` → `{ url, packument(name), integrity(name, version) }` (the server closes and its files are removed through `t.after`); serves `/<name>` (scoped as `%2F` or `/`) and `/<name>/-/<file>.tgz`.
- Test helper `hostNode()` → `{ nodePath: process.execPath, npmCliPath }` from `npm root -g`.

- [ ] **Step 1: Write the fixture and the failing test**

```js
// tests/helpers/npm-registry-fixture.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export function hostNode() {
  const root = execFileSync("npm", ["root", "-g"]).toString().trim();
  return {
    nodePath: process.execPath,
    npmCliPath: path.join(root, "npm", "bin", "npm-cli.js"),
  };
}

/** A local npm registry: packuments and tarballs for the given packages only. */
export async function npmRegistryFixture(t, packages) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "npm-registry-"));
  const tarballs = new Map();
  const docs = new Map();
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url);
    if (tarballs.has(url)) return res.end(tarballs.get(url));
    const doc = docs.get(url.slice(1));
    if (!doc) return res.writeHead(404).end("{}");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(doc));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  });
  for (const pkg of packages) {
    const dir = path.join(
      work,
      `${pkg.name.replace("/", "__")}-${pkg.version}`,
      "package",
    );
    fs.mkdirSync(dir, { recursive: true });
    const manifest = {
      name: pkg.name,
      version: pkg.version,
      ...(pkg.bin ? { bin: pkg.bin } : {}),
      ...(pkg.scripts ? { scripts: pkg.scripts } : {}),
      ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
    };
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
    for (const [file, body] of Object.entries(pkg.files || {})) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), body);
    }
    const bytes = execFileSync("tar", ["-czf", "-", "-C", path.dirname(dir), "package"]);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const base = pkg.name.split("/").pop();
    const tarPath = `/${pkg.name}/-/${base}-${pkg.version}.tgz`;
    tarballs.set(tarPath, bytes);
    const doc = docs.get(pkg.name) || {
      name: pkg.name,
      "dist-tags": {},
      time: {},
      versions: {},
    };
    doc.versions[pkg.version] = {
      ...manifest,
      dist: { tarball: `${url}${tarPath}`, integrity },
    };
    doc.time[pkg.version] =
      pkg.time ||
      new Date(Date.UTC(2026, 0, Object.keys(doc.versions).length)).toISOString();
    doc["dist-tags"].latest = pkg.version;
    docs.set(pkg.name, doc);
  }
  return {
    url,
    packument: (name) => docs.get(name),
    integrity: (name, version) => docs.get(name).versions[version].dist.integrity,
  };
}
```

```js
// tests/integration/mcp-npm-install.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostNode, npmRegistryFixture } from "../helpers/npm-registry-fixture.js";
import { checkNpmLock } from "../../server/features/mcp-packages/lock-check.js";
import {
  installNpm,
  resolveNpm,
} from "../../server/features/mcp-packages/npm-package-install.js";

const work = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-npm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const server = {
  name: "server-x",
  version: "1.0.0",
  bin: { "server-x": "index.js" },
  files: { "index.js": "#!/usr/bin/env node\nconsole.log('ok')\n" },
  dependencies: { helper: "2.0.0" },
};
const helper = { name: "helper", version: "2.0.0", files: { "index.js": "" } };
const scripted = {
  name: "scripted",
  version: "1.0.0",
  bin: "index.js",
  files: { "index.js": "" },
  scripts: { postinstall: "node -e \"require('fs').writeFileSync('ran','1')\"" },
};

test("resolve freezes a registry-only lock; ci installs it without scripts", async (t) => {
  const registry = await npmRegistryFixture(t, [server, helper]);
  const dir = work(t);
  const ref = { registry: "npm", name: "server-x", version: "1.0.0" };
  const options = {
    ref,
    node: hostNode(),
    registry: registry.url,
    cacheDir: path.join(dir, "cache"),
  };
  const { manifestText, lockText } = await resolveNpm({
    stage: path.join(dir, "resolve"),
    ...options,
  });
  const checked = checkNpmLock(lockText, {
    ref,
    integrity: registry.integrity("server-x", "1.0.0"),
    registry: registry.url,
  });
  assert.deepEqual(
    checked.dependencies.map((d) => d.name),
    ["helper", "server-x"],
  );
  const target = path.join(dir, "install");
  await installNpm({
    directory: target,
    manifestText,
    lockText,
    allowScripts: false,
    ...options,
  });
  assert.ok(fs.existsSync(path.join(target, "node_modules/server-x/index.js")));
  assert.ok(fs.existsSync(path.join(target, "node_modules/helper/index.js")));
});

test("install scripts run only when allowed", async (t) => {
  const registry = await npmRegistryFixture(t, [scripted]);
  const dir = work(t);
  const ref = { registry: "npm", name: "scripted", version: "1.0.0" };
  const options = {
    ref,
    node: hostNode(),
    registry: registry.url,
    cacheDir: path.join(dir, "cache"),
  };
  const resolved = await resolveNpm({ stage: path.join(dir, "resolve"), ...options });
  assert.equal(
    checkNpmLock(resolved.lockText, {
      ref,
      integrity: registry.integrity("scripted", "1.0.0"),
      registry: registry.url,
    }).needsScripts,
    true,
  );
  const quiet = path.join(dir, "quiet");
  await installNpm({ directory: quiet, ...resolved, allowScripts: false, ...options });
  assert.equal(fs.existsSync(path.join(quiet, "node_modules/scripted/ran")), false);
  const loud = path.join(dir, "loud");
  await installNpm({ directory: loud, ...resolved, allowScripts: true, ...options });
  assert.equal(fs.existsSync(path.join(loud, "node_modules/scripted/ran")), true);
});

test("the owner's npm configuration never applies", async (t) => {
  const registry = await npmRegistryFixture(t, [helper]);
  const dir = work(t);
  const home = path.join(dir, "owner-home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, ".npmrc"), "registry=http://127.0.0.1:9/\n");
  const ref = { registry: "npm", name: "helper", version: "2.0.0" };
  const { lockText } = await resolveNpm({
    stage: path.join(dir, "resolve"),
    ref,
    node: hostNode(),
    registry: registry.url,
    cacheDir: path.join(dir, "cache"),
    environment: {
      ...process.env,
      HOME: home,
      npm_config_registry: "http://127.0.0.1:9/",
    },
  });
  assert.match(lockText, new RegExp(registry.url.replace(/[.:/]/g, "\\$&")));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/integration/mcp-npm-install.test.js`
Expected: FAIL with missing `npm-package-install.js`.

- [ ] **Step 3: Implement**

```js
// server/features/mcp-packages/npm-package-install.js
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { proxyEnvironment } from "../../lib/proxy-environment.js";
import { readJSON } from "../../lib/storage.js";
import { packageProblem } from "./package-errors.js";
import { privateFolder } from "./verified-files.js";

const executeFile = promisify(execFile);
const failed = () => packageProblem("MCP_PACKAGE_INSTALL_FAILED", 502);

export const npmManifestText = (ref) =>
  `${JSON.stringify({ name: "agentpier-mcp-package", private: true, dependencies: { [ref.name]: ref.version } })}\n`;

/** Only proxy variables are inherited (no npm_config_*); config files are empty. */
function npmEnvironment({ work, node, cacheDir, environment }) {
  for (const name of ["home", "tmp"]) privateFolder(path.join(work, name));
  for (const name of ["user.npmrc", "global.npmrc"])
    fs.writeFileSync(path.join(work, name), "", { mode: 0o600 });
  return {
    ...proxyEnvironment(environment),
    HOME: path.join(work, "home"),
    TMPDIR: path.join(work, "tmp"),
    PATH: [path.dirname(node.nodePath), "/usr/bin", "/bin"].join(path.delimiter),
    npm_config_cache: privateFolder(cacheDir),
    npm_config_userconfig: path.join(work, "user.npmrc"),
    npm_config_globalconfig: path.join(work, "global.npmrc"),
    npm_config_update_notifier: "false",
  };
}
async function npm(args, { cwd, node, env, execute, log }) {
  try {
    const { stdout, stderr } = await execute(
      node.nodePath,
      [node.npmCliPath, ...args, "--no-audit", "--no-fund"],
      { cwd, env, timeout: 600000, maxBuffer: 4 * 1024 * 1024 },
    );
    log?.(`${stdout}\n${stderr}`);
  } catch (error) {
    log?.(`${error.stdout || ""}\n${error.stderr || ""}`);
    throw failed();
  }
}

export async function resolveNpm({
  stage,
  ref,
  node,
  registry,
  cacheDir,
  execute = executeFile,
  environment = process.env,
  log,
}) {
  const work = privateFolder(path.join(stage, ".npm-work"));
  const project = privateFolder(path.join(stage, "resolve"));
  try {
    const manifestText = npmManifestText(ref);
    fs.writeFileSync(path.join(project, "package.json"), manifestText, { mode: 0o600 });
    const env = npmEnvironment({ work, node, cacheDir, environment });
    await npm(
      [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--save-exact",
        `--registry=${registry}`,
      ],
      { cwd: project, node, env, execute, log },
    );
    return {
      manifestText,
      lockText: fs.readFileSync(path.join(project, "package-lock.json"), "utf8"),
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
}

export async function installNpm({
  directory,
  manifestText,
  lockText,
  ref,
  node,
  registry,
  cacheDir,
  allowScripts,
  execute = executeFile,
  environment = process.env,
  log,
}) {
  privateFolder(directory);
  fs.writeFileSync(path.join(directory, "package.json"), manifestText, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "package-lock.json"), lockText, { mode: 0o600 });
  const work = privateFolder(path.join(directory, ".npm-work"));
  try {
    const env = npmEnvironment({ work, node, cacheDir, environment });
    await npm(
      [
        "ci",
        "--include=optional",
        `--registry=${registry}`,
        ...(allowScripts ? [] : ["--ignore-scripts"]),
      ],
      { cwd: directory, node, env, execute, log },
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const installed = readJSON(
    path.join(directory, "node_modules", ...ref.name.split("/"), "package.json"),
    {},
  );
  if (installed.version !== ref.version) throw failed();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/integration/mcp-npm-install.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-packages/npm-package-install.js tests/helpers/npm-registry-fixture.js \
  tests/integration/mcp-npm-install.test.js
git commit -m "feat: resolve and install npm MCP server packages in isolation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Package records in the MCP server database

**Files:**

- Create: `server/features/mcp-packages/package-records.js`
- Modify: `server/features/mcp-servers/mcp-server-store.js` (constructor, `definition`, `publicServer`, `definitions`, `create`)
- Modify: `server/features/mcp-servers/central-changes.js:52-66` and `server/features/assistants/mcp-changes.js:148-160` (pass `pendingCommand` and `packageRecord`)
- Modify: `server/features/operations/mcp-server-backup.js:23-42` (`knownColumns`)
- Test: `tests/unit/mcp-package-records.test.js`; rerun `tests/integration/mcp-server-backup-hashes.test.js`, `tests/integration/mcp-server-host-backups.test.js`

**Interfaces:**

- Produces:
  - `PackageRecords(db, dataDir)` with `get(serverId)` → row object or `null`; `put(serverId, fields)`; `update(serverId, fields)`; `remove(serverId)`; `all()`; `installIds()` → `Set`; `computedStatus(row)` → `"installing" | "failed" | "ready" | "missing"`; `publicFields(serverId)` → `{ source }` or `{}`; `definitionFields(serverId)` → `{ packageStatus, managedDirs }` or `{}`.
  - Row fields (camelCase in JS): `serverId, registry, name, version, program, programPath, allowScripts, lock, lockDigest, integrity, installId, leadingArgs, toolchainDir, status, errorCode, updatedAt`.
  - `source` in responses: `{ registry, name, version, program, allowScripts, status, errorCode, leadingArgs }`, where `leadingArgs` is `0` while `installId` is null (no generated argument is stored yet), so a client always slices the owner's arguments with `source.leadingArgs`.
  - `McpServerStore.create(input, { bind, pendingCommand, packageRecord })`: with `pendingCommand: true` a stdio server is stored with `command` NULL (`input.command` must be absent); `packageRecord` (requires `pendingCommand`) is written in the same transaction, so whatever runs after the create (CLI reconciliation, agent apply) already sees the package.
  - `McpServerStore.definition(input, keepCommand)` stores `input.command ?? null` when `keepCommand` is true (`node:sqlite` refuses `undefined`), so every later update of a pending server keeps it pending.
  - `publicServer` returns `args` for every stdio row, with or without a command; `command` only when one is stored.
  - `CentralMcpChanges.create(input, { …, pendingCommand, packageRecord })` and `McpChanges.create(input, { …, pendingCommand, packageRecord })` pass both to the store.
  - `McpServerStore.packages` (the `PackageRecords` instance).

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/mcp-package-records.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";
import {
  commitInstall,
  stageInstall,
} from "../../server/features/mcp-packages/package-store.js";

function store(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-records-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return {
    dataDir,
    servers: new McpServerStore({ dataDir, pathEnv: "", exists: () => true }),
  };
}
const record = (extra = {}) => ({
  registry: "npm",
  name: "server-x",
  version: "1.0.0",
  program: "server-x",
  programPath: "index.js",
  allowScripts: false,
  lock: "{}",
  lockDigest: "d".repeat(64),
  integrity: "sha512-x",
  installId: null,
  leadingArgs: 0,
  toolchainDir: "/data/toolchains/node",
  status: "installing",
  errorCode: null,
  ...extra,
});
const pending = (servers, input = {}, extra = {}) =>
  servers.create(
    { name: "pkg", transport: "stdio", ...input },
    { pendingCommand: true, packageRecord: record(extra) },
  );

test("a pending packaged server has no command, shows its args and is not compiled", (t) => {
  const { servers } = store(t);
  const server = pending(servers, { args: ["--x"] });
  assert.equal(server.command, undefined);
  assert.deepEqual(server.args, ["--x"]);
  assert.deepEqual(server.source, {
    registry: "npm",
    name: "server-x",
    version: "1.0.0",
    program: "server-x",
    allowScripts: false,
    status: "installing",
    errorCode: null,
    leadingArgs: 0,
  });
  const definition = servers.definitions().find((d) => d.id === server.id);
  assert.equal(definition.command, null);
  assert.equal(definition.packageStatus, "installing");
});

test("an owner edit of a pending server keeps it pending", (t) => {
  const { servers } = store(t);
  const server = pending(servers, { args: ["--x"] });
  const renamed = servers.update(server.id, {
    revision: server.revision,
    name: "renamed",
  });
  assert.equal(renamed.command, undefined);
  assert.deepEqual(renamed.args, ["--x"]);
  assert.equal(renamed.source.status, "installing");
});

test("pendingCommand never stores an owner command; a record needs pendingCommand", (t) => {
  const { servers } = store(t);
  assert.throws(() =>
    servers.create(
      { name: "pkg", transport: "stdio", command: "/bin/sh" },
      { pendingCommand: true },
    ),
  );
  assert.throws(() =>
    servers.create(
      { name: "pkg", transport: "stdio", command: "/bin/sh" },
      { packageRecord: record() },
    ),
  );
  assert.deepEqual(servers.list(), []);
});

test("the record is stored before the CLIs are reconciled", async (t) => {
  const { servers } = store(t);
  const seen = [];
  const changes = new CentralMcpChanges({
    servers,
    onSaved: async () => seen.push(servers.definitions()),
  });
  await changes.create(
    { name: "pkg", transport: "stdio", args: [] },
    {
      confirmStdio: true,
      clis: ["claude"],
      pendingCommand: true,
      packageRecord: record(),
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0].packageStatus, "installing");
  assert.deepEqual(servers.targetsOf(seen[0][0].id).clis, ["claude"]);
});

test("a ready record whose install vanished reports missing", (t) => {
  const { dataDir, servers } = store(t);
  const server = pending(servers);
  const { installId, stage } = stageInstall(dataDir);
  commitInstall(dataDir, { installId, stage, receipt: { lockDigest: "d".repeat(64) } });
  servers.packages.put(server.id, record({ status: "ready", installId, leadingArgs: 1 }));
  let definition = servers.definitions().find((d) => d.id === server.id);
  assert.equal(definition.packageStatus, "ready");
  assert.deepEqual(definition.managedDirs, [
    path.join(dataDir, "mcp-packages", "installs", installId),
    "/data/toolchains/node",
  ]);
  assert.equal(servers.get(server.id).source.leadingArgs, 1);
  fs.rmSync(path.join(dataDir, "mcp-packages", "installs", installId), {
    recursive: true,
  });
  definition = servers.definitions().find((d) => d.id === server.id);
  assert.equal(definition.packageStatus, "missing");
  assert.equal(servers.get(server.id).source.status, "missing");
});

test("removing the server removes its record", (t) => {
  const { servers } = store(t);
  const server = pending(servers);
  servers.remove(server.id);
  assert.equal(servers.packages.get(server.id), null);
});

test("an own-command server carries no package fields", (t) => {
  const { servers } = store(t);
  const server = servers.create({ name: "own", transport: "stdio", command: "/bin/x" });
  assert.equal(servers.get(server.id).source, undefined);
  assert.equal(servers.definitions()[0].packageStatus, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/mcp-package-records.test.js`
Expected: FAIL (`pendingCommand` unknown, `packages` undefined).

- [ ] **Step 3: Implement records and hook them into the store**

```js
// server/features/mcp-packages/package-records.js
import { installDirectory, readInstall } from "./package-store.js";

const schema = `
CREATE TABLE IF NOT EXISTS server_packages(
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  registry TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL,
  program TEXT NOT NULL, program_path TEXT NOT NULL, allow_scripts INTEGER NOT NULL DEFAULT 0,
  lock TEXT NOT NULL, lock_digest TEXT NOT NULL, integrity TEXT NOT NULL,
  install_id TEXT, leading_args INTEGER NOT NULL DEFAULT 0, toolchain_dir TEXT,
  status TEXT NOT NULL CHECK(status IN ('installing','ready','failed')),
  error_code TEXT, updated_at INTEGER NOT NULL);`;
const columns = {
  registry: "registry",
  name: "name",
  version: "version",
  program: "program",
  programPath: "program_path",
  allowScripts: "allow_scripts",
  lock: "lock",
  lockDigest: "lock_digest",
  integrity: "integrity",
  installId: "install_id",
  leadingArgs: "leading_args",
  toolchainDir: "toolchain_dir",
  status: "status",
  errorCode: "error_code",
};
const fromRow = (row) =>
  row && {
    serverId: row.server_id,
    ...Object.fromEntries(
      Object.entries(columns).map(([key, column]) => [key, row[column]]),
    ),
    allowScripts: row.allow_scripts === 1,
    updatedAt: row.updated_at,
  };
const toValue = (key, value) =>
  key === "allowScripts" ? (value ? 1 : 0) : (value ?? null);

/** One package source per server, beside the servers it belongs to (and backed up with them). */
export class PackageRecords {
  constructor(db, dataDir) {
    Object.assign(this, { db, dataDir });
    db.exec(schema);
  }
  get(serverId) {
    return (
      fromRow(
        this.db.prepare("SELECT * FROM server_packages WHERE server_id=?").get(serverId),
      ) ?? null
    );
  }
  all() {
    return this.db.prepare("SELECT * FROM server_packages").all().map(fromRow);
  }
  put(serverId, fields) {
    const keys = Object.keys(columns);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO server_packages(server_id,${keys.map((k) => columns[k]).join(",")},updated_at) VALUES (?,${keys.map(() => "?").join(",")},?)`,
      )
      .run(serverId, ...keys.map((k) => toValue(k, fields[k])), Date.now());
  }
  update(serverId, fields) {
    const current = this.get(serverId);
    if (current) this.put(serverId, { ...current, ...fields });
  }
  remove(serverId) {
    this.db.prepare("DELETE FROM server_packages WHERE server_id=?").run(serverId);
  }
  installIds() {
    return new Set(
      this.all()
        .map((row) => row.installId)
        .filter(Boolean),
    );
  }
  computedStatus(row) {
    if (row.status !== "ready") return row.status;
    return row.installId && readInstall(this.dataDir, row.installId, row.lockDigest)
      ? "ready"
      : "missing";
  }
  publicFields(serverId) {
    const row = this.get(serverId);
    if (!row) return {};
    return {
      source: {
        registry: row.registry,
        name: row.name,
        version: row.version,
        program: row.program,
        allowScripts: row.allowScripts,
        status: this.computedStatus(row),
        errorCode: row.errorCode,
        // No generated argument is stored before the first install.
        leadingArgs: row.installId ? row.leadingArgs : 0,
      },
    };
  }
  definitionFields(serverId) {
    const row = this.get(serverId);
    if (!row) return {};
    const status = this.computedStatus(row);
    return {
      packageStatus: status,
      managedDirs:
        status === "ready"
          ? [installDirectory(this.dataDir, row.installId), row.toolchainDir].filter(
              Boolean,
            )
          : [],
    };
  }
}
```

Store edits (keep each change to the lines shown):

```js
// mcp-server-store.js — import
import { PackageRecords } from "../mcp-packages/package-records.js";
// constructor, after `this.cliEntries = new CliEntryStore(this.db);`
    this.packages = new PackageRecords(this.db, dataDir);
// publicServer(row) — replaces the line `...(row.command ? { command: row.command, args: JSON.parse(row.args) } : {}),`
      // A packaged server shows its args while its command is still pending.
      ...(row.transport === "stdio"
        ? {
            ...(row.command ? { command: row.command } : {}),
            args: JSON.parse(row.args),
          }
        : {}),
// publicServer(row) — after `revision: row.revision,`
      ...this.packages.publicFields(row.id),
// definitions() — after `oauthScope: row.oauth_scope ?? null,`
          ...this.packages.definitionFields(row.id),
// definition(input, keepCommand) — the stdio `command:` property
        // node:sqlite cannot bind undefined: a pending command is stored as NULL.
        command: keepCommand
          ? (input.command ?? null)
          : resolveCommand(input.command, this.resolveOptions),
```

`create` becomes:

```js
  /**
   * `bind`: `[kind, targetId]` pairs bound in the same transaction. `pendingCommand`
   * stores a stdio server whose command a package install generates later;
   * `packageRecord` is its package source, written in the same transaction.
   */
  create(input, { bind = [], pendingCommand = false, packageRecord = null } = {}) {
    requireLiteralValues(input);
    if (pendingCommand && (input?.transport !== "stdio" || input.command !== undefined))
      throw invalid();
    if (packageRecord && !pendingCommand) throw invalid();
    const fields = this.definition(input, pendingCommand);
    const id = randomUUID();
    this.transaction(() => {
      this.insertOrUpdate(
        "INSERT INTO servers(name,transport,url,command,args,cwd,auth,oauth_scope,revision,id) VALUES (?,?,?,?,?,?,?,?,?,?)",
        fields,
        id,
        1,
      );
      this.writeSecrets(id, input, fields.transport, true, fields.auth);
      for (const [kind, targetId] of bind) this.bind(id, kind, targetId);
      if (packageRecord) this.packages.put(id, packageRecord);
    });
    return this.get(id);
  }
```

The `keepCommand` change also covers `patched()`, which passes `row.command ?? undefined` with `keepCommand` true for every update that leaves the command alone.

`central-changes.js` `create(input, { clis: wanted, ...options })`: the agents path already spreads `options` into `agents.create(input, { ...options, clis })`. The direct path becomes:

```js
server = this.servers.create(input, {
  bind: clis.map((cli) => ["cli", cli]),
  pendingCommand: options.pendingCommand === true,
  packageRecord: options.packageRecord ?? null,
});
```

`assistants/mcp-changes.js`:

```js
  /** `clis`: the coding CLIs the new server is bound to in the same write. */
  create(
    input,
    { confirmStdio = false, clis = [], pendingCommand = false, packageRecord = null } = {},
  ) {
    return this.assistants.admit(async () => {
      // A reference is refused before the owner is asked to confirm a local command.
      requireLiteralValues(input);
      if (record(input) && input.transport === "stdio")
        requireStdioConfirmation(confirmStdio === true);
      const server = this.servers.create(input, {
        bind: clis.map((cli) => ["cli", cli]),
        pendingCommand,
        packageRecord,
      });
      // Unbound servers are not compiled; nothing to apply.
      return server;
    });
  }
```

`operations/mcp-server-backup.js` `knownColumns`: add

```js
  server_packages: [
    "server_id", "registry", "name", "version", "program", "program_path", "allow_scripts", "lock",
    "lock_digest", "integrity", "install_id", "leading_args", "toolchain_dir",
    "status", "error_code", "updated_at",
  ],
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/unit/mcp-package-records.test.js tests/unit/mcp-server-store.test.js tests/unit/mcp-server-store-cli.test.js tests/unit/mcp-central-changes.test.js tests/integration/mcp-server-backup-hashes.test.js tests/integration/mcp-server-host-backups.test.js tests/integration/mcp-server-backup-crafted.test.js && wc -l server/features/mcp-servers/mcp-server-store.js`
Expected: PASS; the store is about 530 lines. If a backup test enumerates exact table lists, add `server_packages` to its expectation (the table is part of the sanitized copy; it holds no secret).

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-packages/package-records.js server/features/mcp-servers/mcp-server-store.js \
  server/features/mcp-servers/central-changes.js server/features/assistants/mcp-changes.js \
  server/features/operations/mcp-server-backup.js tests/unit/mcp-package-records.test.js tests/integration
git commit -m "feat: store MCP package sources with their servers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Compilers skip packages that are not ready; sandbox grants

**Files:**

- Modify: `server/features/assistants/openclaw-config/mcp-servers.js:30-33` (`mcpServerConfig`)
- Modify: `server/features/mcp-servers/cli-reconciler.js:78-84` (`desired`)
- Modify: `server/features/mcp-servers/cli-status.js:18-36` (reason `package`)
- Modify: `server/lib/i18n/de/mcp-servers.js` and `server/lib/i18n/en/mcp-servers.js` (`cliReasonPackage`), `web/lib/i18n/{de,en}/mcp-cli.js` (`reasons.package`)
- Modify: `server/features/mcp-servers/cli-grants.js:93-110` (managed directories)
- Test: create `tests/unit/mcp-package-compile.test.js` and `tests/unit/mcp-package-cli-status.test.js`; rerun `tests/unit/openclaw-mcp-config.test.js`, `tests/unit/cli-mcp-grants.test.js`, `tests/unit/cli-mcp-native.test.js`

**Interfaces:**

- Consumes: `definition.packageStatus`, `definition.managedDirs` (Task 6).
- Produces: OpenClaw skips a packaged server whose `packageStatus !== "ready"` (name in `skipped`); CLI status `{ status: "error", reason: "package" }`; nono grants `{ access: "read", path: dir }` for each managed directory inside `<data>/mcp-packages/installs/` or `<data>/toolchains/`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/mcp-package-compile.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mcpServerConfig } from "../../server/features/assistants/openclaw-config/mcp-servers.js";
import { stdioGrants } from "../../server/features/mcp-servers/cli-grants.js";

const packaged = (status) => ({
  id: "s1",
  name: "pkg",
  transport: "stdio",
  command: "/data/toolchains/node-v26.7.0-darwin-arm64/bin/node",
  args: ["/data/mcp-packages/installs/i/node_modules/x/index.js"],
  cwd: null,
  auth: "headers",
  packageStatus: status,
  managedDirs:
    status === "ready"
      ? ["/data/mcp-packages/installs/i", "/data/toolchains/node-v26.7.0-darwin-arm64"]
      : [],
});

test("OpenClaw compiles a packaged server only when its install is ready", () => {
  const secrets = { headers: {}, env: {} };
  assert.notEqual(mcpServerConfig(packaged("ready"), secrets), null);
  for (const status of ["installing", "failed", "missing"])
    assert.equal(mcpServerConfig(packaged(status), secrets), null, status);
});

test("managed directories inside the data dir get read grants; others do not", () => {
  const grants = stdioGrants(
    [
      {
        ...packaged("ready"),
        managedDirs: [...packaged("ready").managedDirs, "/etc", "/data/assistants"],
      },
    ],
    { dataDir: "/data", realpath: (p) => p, executable: () => true, readHead: () => "" },
  );
  assert.deepEqual(
    grants.filter((g) => g.path.startsWith("/data") || g.path === "/etc"),
    [
      { access: "read", path: "/data/mcp-packages/installs/i" },
      { access: "read", path: "/data/toolchains/node-v26.7.0-darwin-arm64" },
    ],
  );
});
```

```js
// tests/unit/mcp-package-cli-status.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { cliMcpFixture } from "../helpers/cli-mcp.js";
import { reasonIdentity } from "../../server/features/mcp-servers/cli-status.js";

const record = (status) => ({
  registry: "npm",
  name: "server-x",
  version: "1.0.0",
  program: "server-x",
  programPath: "index.js",
  allowScripts: false,
  lock: "{}",
  lockDigest: "d".repeat(64),
  integrity: "sha512-x",
  installId: null,
  leadingArgs: 0,
  toolchainDir: null,
  status,
  errorCode: status === "failed" ? "MCP_PACKAGE_INSTALL_FAILED" : null,
});

test("a CLI reports a packaged server that is not ready with reason package", (t) => {
  const f = cliMcpFixture(t);
  for (const status of ["installing", "failed"]) {
    const server = f.servers.create(
      { name: `pkg-${status}`, transport: "stdio", args: [] },
      { bind: [["cli", "claude"]], pendingCommand: true, packageRecord: record(status) },
    );
    assert.equal(f.reconciler.desired("claude").get(server.id).reason, "package", status);
  }
  assert.deepEqual(reasonIdentity("package"), {
    messageKey: "mcpServers.cliReasonPackage",
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/mcp-package-compile.test.js tests/unit/mcp-package-cli-status.test.js`
Expected: FAIL (installing server compiled; no managed grants; reason `invalid` instead of `package`).

- [ ] **Step 3: Implement**

`openclaw-config/mcp-servers.js`, first line of `mcpServerConfig` after the name check:

```js
// A packaged server runs only from a verified install (docs/mcp.md).
if (server.packageStatus !== undefined && server.packageStatus !== "ready") return null;
```

`cli-reconciler.js` in `desired`, before `const support = cliSupport(cli, definition);`:

```js
      if (definition.packageStatus !== undefined && definition.packageStatus !== "ready") {
        out.set(definition.id, { definition, reason: "package" });
        continue;
      }
```

`cli-status.js` `reasonMessages`: add `package: messages.cliReasonPackage,` in the per-server group (after `duplicate`). Server catalogs, after `cliReasonDuplicate` (same key in both, sentence style like the neighbouring keys):

- `server/lib/i18n/de/mcp-servers.js`: `cliReasonPackage: "Das Paket des Servers ist noch nicht installiert oder fehlt.",`
- `server/lib/i18n/en/mcp-servers.js`: `cliReasonPackage: "The server's package is not installed yet or is missing.",`

Browser catalogs (lower-case fragment like the other `reasons`): `web/lib/i18n/de/mcp-cli.js` `reasons.package: "sein Paket ist noch nicht installiert oder fehlt"`, `web/lib/i18n/en/mcp-cli.js` `reasons.package: "its package is not installed yet or is missing"`.

`cli-grants.js` inside the loop, after `for (const file of paths) grants.push(...)`:

```js
// A packaged server's install and toolchain live in the data dir by design; only
// those two trees are opened, read-only (docs/sandbox.md).
const managedRoots = data
  ? [path.join(data, "mcp-packages", "installs"), path.join(data, "toolchains")]
  : [];
for (const dir of definition.managedDirs || []) {
  const resolved = real(dir);
  if (managedRoots.some((root) => resolved !== root && within(resolved, root)))
    grants.push({ access: "read", path: resolved });
}
```

The command (managed Node) lies inside `dataDir`, so `add(definition.command)` grants nothing for it; the directory grant covers it and its `lib/`.

- [ ] **Step 4: Run tests**

Run: `node --test tests/unit/mcp-package-compile.test.js tests/unit/mcp-package-cli-status.test.js tests/unit/openclaw-mcp-config.test.js tests/unit/cli-mcp-grants.test.js tests/unit/cli-mcp-native.test.js tests/unit/i18n-catalogs.test.js tests/unit/server-i18n-catalogs.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/assistants/openclaw-config/mcp-servers.js server/features/mcp-servers/cli-reconciler.js \
  server/features/mcp-servers/cli-status.js server/features/mcp-servers/cli-grants.js \
  server/lib/i18n/de/mcp-servers.js server/lib/i18n/en/mcp-servers.js \
  web/lib/i18n/de/mcp-cli.js web/lib/i18n/en/mcp-cli.js \
  tests/unit/mcp-package-compile.test.js tests/unit/mcp-package-cli-status.test.js
git commit -m "feat: compile packaged MCP servers only from a ready install

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Jobs and the McpPackages service

**Files:**

- Create: `server/features/mcp-packages/install-jobs.js`
- Create: `server/features/mcp-packages/mcp-packages.js`
- Test: `tests/unit/mcp-install-jobs.test.js`

**Interfaces:**

- Produces `PackageJobs({ settled })`:
  - `run(serverId, { kind, installId }, work)` → job snapshot `{ kind, state: "running", code: null, log: "" }`; throws `MCP_PACKAGE_BUSY` (409) while that server has a running job; `work(log, note)` is awaited in the background; `note({ toolchainDir })` records the toolchain the job uses; a rejection stores `state: "failed"` and `code = packageCode(error, "MCP_PACKAGE_INSTALL_FAILED")`. After the state is final, `settled(serverId)` runs once (McpPackages prunes there, so a failed job's stage is removed too).
  - `get(serverId)` → snapshot or `null`; `runningInstallIds()` → `Set`; `runningToolchainDirs()` → `Set`; `idle()` → promise resolving when no job runs (tests).
  - Log tail: at most 4,000 characters, URL credentials replaced (`https://user:pass@` → `https://***@`).
- Produces `McpPackages` (`mcp-packages.js`), constructor `{ dataDir, servers, changes, registry = npmRegistry, download, toolchain = (kind) => ensureToolchain(kind, { dataDir }), execute, environment, now = Date.now, previewTtl = 15 * 60 * 1000 }`:
  - `versions({ registry, name })` → `{ latest, versions }`.
  - `preview({ registry, name, version, allowScripts = false, serverId })` → `{ previewId, registry, name, version, integrity, dependencyCount, dependencies, programs: [name], needsScripts, diff }` (`diff` only with `serverId` of a packaged server).
  - `confirmedPreview(previewId, source, wanted)` → `{ preview, program }`: the preview taken once, its program chosen, the scripts rule checked (shared by create, attach and update).
  - `createServer(input, { clis, previewId, program })` → public server (with `source`, status `installing`); `input.source` must match the preview; the record is written in the server's create transaction (`packageRecord`).
  - `attach(id, { source, previewId, program }, beforeInstall?)` (D1) → public server: an existing stdio server without a record switches to the package. The preview is checked first, then `beforeInstall()` runs (the route saves the owner's other edits there), then the record is written as `installing` and the install job starts. The own command stays stored until the switch replaces command and args together.
  - `isPackaged(id)` → boolean.
  - `prepareUpdate(id, input)` → the patch to send through `changes.update` for a packaged server (`command` refused; `args` prefixed with the generated args currently stored).
  - `detach(id, update)` → refuses `MCP_PACKAGE_BUSY` while a job runs, awaits `update()` (the route's switch to an own command), removes the record and returns `prune()`.
  - `updatePackage(id, { version, allowScripts, previewId, program })` → `{ job }`.
  - `reinstall(id)` → `{ job }`.
  - `status(id)` → `{ source, job, error }`; `error` is `null` or `{ code, message, messageKey }` for the failed job's code (else the record's `errorCode`), so the browser shows it through `serverText` like any server message.
  - `start()` → removes leftover `mcp-packages/previews/`, marks `installing` records without a running job as `failed` (`MCP_PACKAGE_INSTALL_FAILED`) and returns `prune()`.
  - `prune()` → synchronously `pruneInstalls(dataDir, records' install ids ∪ running jobs' install ids)`; returns the promise of `pruneToolchains(dataDir, inUse)` (never rejects; a failure is logged with its code). `inUse` is every record's `toolchainDir` and every running job's toolchain, nulls dropped, each mapped to `path.join(toolchainRoot(dataDir), path.basename(dir))` when the basename starts with `node-` or `python-`, others dropped.
- Install order (Review Focus 6): `activate()` reads the previous record, writes the new record (`installId`, `leadingArgs`, `toolchainDir`, `status: "ready"`) and then switches the command through `changes.update`, so the reconciliation and the agents' apply it triggers see the package ready. A failed switch restores the previous record (a first install then ends `failed`, an update stays on the old install).
- Owner args across the switch: `switchCommand` slices the owner's args with the leading count stored before the switch (`0` before the first install); while a switch runs, `prepareUpdate` uses that same count (`this.switching`), so an owner edit in that window is neither duplicated nor lost.

- [ ] **Step 1: Write the failing jobs test**

```js
// tests/unit/mcp-install-jobs.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { PackageJobs } from "../../server/features/mcp-packages/install-jobs.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("one job per server, failures keep a stable code and a redacted tail", async () => {
  const jobs = new PackageJobs();
  let finish;
  jobs.run("s1", { kind: "install", installId: "i1" }, (log) => {
    log("GET https://user:secret@proxy.example/x");
    return new Promise((resolve) => (finish = resolve));
  });
  assert.throws(() => jobs.run("s1", { kind: "update" }, async () => {}), {
    code: "MCP_PACKAGE_BUSY",
  });
  assert.deepEqual([...jobs.runningInstallIds()], ["i1"]);
  await tick();
  finish();
  await jobs.idle();
  assert.equal(jobs.get("s1").state, "done");
  jobs.run("s1", { kind: "update" }, async () => {
    throw Object.assign(Error("/private/path"), { code: "EACCES" });
  });
  await jobs.idle();
  const failed = jobs.get("s1");
  assert.equal(failed.state, "failed");
  assert.equal(failed.code, "MCP_PACKAGE_INSTALL_FAILED");
  assert.doesNotMatch(JSON.stringify(failed), /secret|private/);
});

test("the log tail is bounded", async () => {
  const jobs = new PackageJobs();
  jobs.run("s", { kind: "install" }, async (log) => log("x".repeat(10000)));
  await jobs.idle();
  assert.ok(jobs.get("s").log.length <= 4000);
});

test("a running job's toolchain is in use; settled runs once its state is final", async () => {
  const settled = [];
  const jobs = new PackageJobs({
    settled: (id) => settled.push([id, jobs.get(id).state]),
  });
  let finish;
  jobs.run("s1", { kind: "install", installId: "i1" }, (_log, note) => {
    note({ toolchainDir: "/data/toolchains/node-v1-x" });
    return new Promise((resolve) => (finish = resolve));
  });
  await tick();
  assert.deepEqual([...jobs.runningToolchainDirs()], ["/data/toolchains/node-v1-x"]);
  assert.deepEqual(settled, []);
  finish();
  await jobs.idle();
  assert.deepEqual(settled, [["s1", "done"]]);
  assert.equal(jobs.runningToolchainDirs().size, 0);
  assert.equal(jobs.runningInstallIds().size, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/mcp-install-jobs.test.js`
Expected: FAIL with missing module.

- [ ] **Step 3: Implement jobs**

```js
// server/features/mcp-packages/install-jobs.js
import { packageCode, packageProblem } from "./package-errors.js";

const tailLimit = 4000;
const redact = (text) => String(text).replace(/(\w+:\/\/)[^\s/@]+@/g, "$1***@");

/** Background package jobs, one per server; state lives in memory only. */
export class PackageJobs {
  constructor({ settled = () => {} } = {}) {
    this.settled = settled;
    this.jobs = new Map();
    this.running = new Set();
  }
  get(serverId) {
    const job = this.jobs.get(serverId);
    return job
      ? { kind: job.kind, state: job.state, code: job.code, log: job.log }
      : null;
  }
  runningJobs() {
    return [...this.jobs.values()].filter((job) => job.state === "running");
  }
  runningInstallIds() {
    return new Set(
      this.runningJobs()
        .map((job) => job.installId)
        .filter(Boolean),
    );
  }
  runningToolchainDirs() {
    return new Set(
      this.runningJobs()
        .map((job) => job.toolchainDir)
        .filter(Boolean),
    );
  }
  run(serverId, { kind, installId = null }, work) {
    if (this.jobs.get(serverId)?.state === "running")
      throw packageProblem("MCP_PACKAGE_BUSY", 409);
    const job = {
      kind,
      installId,
      toolchainDir: null,
      state: "running",
      code: null,
      log: "",
    };
    this.jobs.set(serverId, job);
    const log = (text) => {
      job.log = redact(`${job.log}${text}\n`).slice(-tailLimit);
    };
    const note = ({ toolchainDir } = {}) => {
      if (typeof toolchainDir === "string") job.toolchainDir = toolchainDir;
    };
    const promise = Promise.resolve()
      .then(() => work(log, note))
      .then(
        () => {
          job.state = "done";
        },
        (error) => {
          job.state = "failed";
          job.code = packageCode(error, "MCP_PACKAGE_INSTALL_FAILED");
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
    this.running.add(promise);
    return this.get(serverId);
  }
  async idle() {
    while (this.running.size) await Promise.all([...this.running]);
  }
}
```

Note: `job.code` takes only codes from `packageCodes`; `EACCES` falls back.

- [ ] **Step 4: Implement the service**

```js
// server/features/mcp-packages/mcp-packages.js
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { record } from "../extensions/mcp-config.js";
import { privateFolder } from "./verified-files.js";
import { ensureToolchain, pruneToolchains, toolchainRoot } from "./toolchains.js";
import { PackageJobs } from "./install-jobs.js";
import { checkNpmLock, lockDiff } from "./lock-check.js";
import { installNpm, npmManifestText, resolveNpm } from "./npm-package-install.js";
import { packageCode, packageProblem } from "./package-errors.js";
import { packageName, packageRef } from "./package-spec.js";
import {
  commitInstall,
  npmCommand,
  packageRoot,
  pruneInstalls,
  stageInstall,
} from "./package-store.js";
import { chooseProgram, npmPrograms } from "./program-select.js";
import {
  npmPackument,
  npmRegistry,
  npmVersionInfo,
  npmVersions,
} from "./registry-metadata.js";

const previewLimit = 20;
const invalid = () => packageProblem("MCP_PACKAGE_INVALID", 400);
/**
 * A toolchain folder by name under this data dir's root, else null. pruneToolchains
 * stops pruning for any entry outside its root (a real path such as /private/var for
 * /var, or a toolchain of another data dir), so entries are kept by folder name.
 */
const toolchainEntry = (dataDir, dir) =>
  typeof dir === "string" && /^(node|python)-/.test(path.basename(dir))
    ? path.join(toolchainRoot(dataDir), path.basename(dir))
    : null;
/** The record fields a confirmed preview and its program determine. */
const sourceFields = (preview, program) => ({
  ...preview.ref,
  program: program.name,
  programPath: program.path,
  allowScripts: preview.allowScripts,
  lock: preview.lockText,
  lockDigest: preview.digest,
  integrity: preview.integrity,
});

/** Previews, installs, updates and removes packaged MCP servers (docs/mcp.md). */
export class McpPackages {
  constructor({
    dataDir,
    servers,
    changes,
    registry = npmRegistry,
    download,
    toolchain = (kind) => ensureToolchain(kind, { dataDir }),
    execute,
    environment,
    now = Date.now,
    previewTtl = 15 * 60 * 1000,
  }) {
    Object.assign(this, {
      dataDir,
      servers,
      changes,
      registry,
      download,
      toolchain,
      execute,
      environment,
      now,
      previewTtl,
    });
    this.records = servers.packages;
    this.jobs = new PackageJobs({ settled: () => this.prune() });
    this.previews = new Map();
    // serverId → leading args stored before a running switch (see activate()).
    this.switching = new Map();
  }
  get cacheDir() {
    return path.join(packageRoot(this.dataDir), ".npm-cache");
  }
  async versions(input) {
    const name = packageName(input);
    return npmVersions(
      await npmPackument(name, { registry: this.registry, download: this.download }),
    );
  }
  async preview(input) {
    const ref = packageRef(input);
    const allowScripts = input.allowScripts === true;
    const info = npmVersionInfo(
      await npmPackument(ref.name, { registry: this.registry, download: this.download }),
      ref.version,
    );
    const programs = npmPrograms(ref.name, info.bin);
    if (!programs.length) throw packageProblem("MCP_PACKAGE_NO_PROGRAM", 400);
    const node = await this.toolchain("node");
    const previewId = randomUUID();
    // Previews resolve outside installs/, so pruning never races a running preview.
    const stage = privateFolder(
      path.join(packageRoot(this.dataDir), "previews", previewId),
    );
    let resolved;
    try {
      resolved = await resolveNpm({
        stage,
        ref,
        node,
        registry: this.registry,
        cacheDir: this.cacheDir,
        execute: this.execute,
        environment: this.environment,
      });
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
    const checked = checkNpmLock(resolved.lockText, {
      ref,
      integrity: info.integrity,
      registry: this.registry,
    });
    const current = input.serverId ? this.records.get(input.serverId) : null;
    const diff = current
      ? lockDiff(
          checkNpmLock(current.lock, {
            ref: current,
            integrity: current.integrity,
            registry: this.registry,
          }).dependencies,
          checked.dependencies,
        )
      : null;
    const needsScripts = checked.needsScripts || info.installScripts;
    this.previews.set(previewId, {
      ref,
      allowScripts,
      integrity: info.integrity,
      programs,
      needsScripts,
      ...resolved,
      digest: checked.digest,
      expires: this.now() + this.previewTtl,
    });
    while (this.previews.size > previewLimit)
      this.previews.delete(this.previews.keys().next().value);
    return {
      previewId,
      ...ref,
      integrity: info.integrity,
      dependencyCount: checked.dependencies.length,
      dependencies: checked.dependencies,
      programs: programs.map((p) => p.name),
      needsScripts,
      diff,
    };
  }
  /** The confirmed preview for `source`; expired, unknown or different → refused. */
  takePreview(previewId, source) {
    const preview = this.previews.get(previewId);
    this.previews.delete(previewId);
    const ref = packageRef(source);
    if (
      !preview ||
      preview.expires < this.now() ||
      preview.ref.registry !== ref.registry ||
      preview.ref.name !== ref.name ||
      preview.ref.version !== ref.version ||
      preview.allowScripts !== (source.allowScripts === true)
    )
      throw packageProblem("MCP_PACKAGE_PREVIEW_EXPIRED", 409);
    return preview;
  }
  /** The preview taken once, its program chosen and the scripts rule checked. */
  confirmedPreview(previewId, source, wanted) {
    const preview = this.takePreview(previewId, source);
    const program = chooseProgram(preview.programs, wanted);
    if (preview.needsScripts === true && !preview.allowScripts)
      throw packageProblem("MCP_PACKAGE_NEEDS_SCRIPTS", 400);
    return { preview, program };
  }
  /** The record of a confirmed package before its first install. */
  pendingRecord({ preview, program }) {
    return {
      ...sourceFields(preview, program),
      installId: null,
      leadingArgs: 0,
      toolchainDir: null,
      status: "installing",
      errorCode: null,
    };
  }
  isPackaged(id) {
    return !!this.records.get(id);
  }
  async createServer(input, { clis, previewId, program } = {}) {
    if (!record(input) || input.transport !== "stdio" || input.command !== undefined)
      throw invalid();
    const { source, ...definition } = input;
    if (!record(source)) throw invalid();
    const confirmed = this.confirmedPreview(previewId, source, program ?? source.program);
    // Written in the server's own transaction: the first reconciliation already sees
    // a package that is installing, not a stdio server without a command.
    const server = await this.changes.create(definition, {
      confirmStdio: true,
      pendingCommand: true,
      packageRecord: this.pendingRecord(confirmed),
      ...(clis === undefined ? {} : { clis }),
    });
    this.install(server.id, { ...confirmed, kind: "install" });
    return this.servers.get(server.id);
  }
  /**
   * Switches an own-command stdio server to a package (owner decision D1). The own
   * command stays stored until the install switches command and args together; until
   * then the compilers skip the server, as for a new package.
   */
  async attach(id, { source, previewId, program } = {}, beforeInstall) {
    const server = this.servers.get(id);
    if (server.transport !== "stdio" || this.isPackaged(id) || !record(source))
      throw invalid();
    const confirmed = this.confirmedPreview(previewId, source, program ?? source.program);
    await beforeInstall?.();
    this.records.put(id, this.pendingRecord(confirmed));
    this.install(id, { ...confirmed, kind: "install" });
    return this.servers.get(id);
  }
  /** Installs `preview` (or the stored lock) and switches the server to it. */
  install(serverId, { preview, program, kind }) {
    const { installId, stage } = stageInstall(this.dataDir);
    return this.jobs.run(serverId, { kind, installId }, async (log, note) => {
      try {
        const node = await this.toolchain("node");
        note({ toolchainDir: node.directory });
        await installNpm({
          directory: stage,
          manifestText: preview.manifestText,
          lockText: preview.lockText,
          ref: preview.ref,
          node,
          registry: this.registry,
          cacheDir: this.cacheDir,
          allowScripts: preview.allowScripts,
          execute: this.execute,
          environment: this.environment,
          log,
        });
        const receipt = {
          ...preview.ref,
          integrity: preview.integrity,
          lockDigest: preview.digest,
          allowScripts: preview.allowScripts,
          program,
          toolchain: { kind: "node", version: node.version, directory: node.directory },
        };
        commitInstall(this.dataDir, { installId, stage, receipt });
        const { command, leading } = npmCommand(
          this.dataDir,
          { ...receipt, installId },
          node,
        );
        await this.activate(
          serverId,
          {
            ...sourceFields(preview, program),
            installId,
            leadingArgs: leading.length,
            toolchainDir: node.directory ?? null,
            status: "ready",
            errorCode: null,
          },
          command,
          leading,
        );
      } catch (error) {
        const current = this.records.get(serverId);
        if (current && current.status !== "ready")
          this.records.update(serverId, {
            status: "failed",
            errorCode: packageCode(error, "MCP_PACKAGE_INSTALL_FAILED"),
          });
        throw error;
      }
    });
  }
  /**
   * The ready record first, then the command switch through the normal update path:
   * the reconciliation and the agents' apply it triggers already see the package
   * ready. A failed switch restores the previous record.
   */
  async activate(serverId, fields, command, leading) {
    const previous = this.records.get(serverId);
    // Before the first install the stored args are the owner's only.
    const before = previous?.installId ? previous.leadingArgs : 0;
    this.switching.set(serverId, before);
    this.records.put(serverId, fields);
    try {
      await this.switchCommand(serverId, command, leading, before);
    } catch (error) {
      if (previous) this.records.put(serverId, previous);
      throw error;
    } finally {
      this.switching.delete(serverId);
    }
  }
  /** Through the normal update path: agents apply live, CLIs reconcile. One retry on 409. */
  async switchCommand(serverId, command, leading, before) {
    for (let attempt = 0; ; attempt++) {
      const server = this.servers.get(serverId);
      const owner = (server.args || []).slice(before);
      try {
        await this.changes.update(
          serverId,
          { revision: server.revision, command, args: [...leading, ...owner] },
          { confirmStdio: true },
        );
        return;
      } catch (error) {
        if (error?.status !== 409 || attempt > 0) throw error;
      }
    }
  }
  /** Generated args stored in front of the owner's; 0 before the first install. */
  storedLeading(id, row) {
    if (this.switching.has(id)) return this.switching.get(id);
    return row?.installId ? row.leadingArgs : 0;
  }
  prepareUpdate(id, input) {
    const row = this.records.get(id);
    if (!row || !record(input)) return input;
    if (input.command !== undefined) throw invalid();
    if (input.args === undefined) return input;
    const leading = (this.servers.get(id).args || []).slice(
      0,
      this.storedLeading(id, row),
    );
    return { ...input, args: [...leading, ...input.args] };
  }
  /** `update` switches the server to an own command first; then the record goes. */
  async detach(id, update) {
    if (this.jobs.get(id)?.state === "running")
      throw packageProblem("MCP_PACKAGE_BUSY", 409);
    if (!this.isPackaged(id)) throw invalid();
    await update?.();
    this.records.remove(id);
    return this.prune();
  }
  async updatePackage(id, { version, allowScripts, previewId, program } = {}) {
    const row = this.records.get(id);
    if (!row) throw invalid();
    const confirmed = this.confirmedPreview(
      previewId,
      { registry: row.registry, name: row.name, version, allowScripts },
      program ?? row.program,
    );
    return { job: this.install(id, { ...confirmed, kind: "update" }) };
  }
  reinstall(id) {
    const row = this.records.get(id);
    if (!row) throw invalid();
    const ref = { registry: row.registry, name: row.name, version: row.version };
    const preview = {
      ref,
      allowScripts: row.allowScripts,
      integrity: row.integrity,
      manifestText: npmManifestText(ref),
      lockText: row.lock,
      digest: row.lockDigest,
    };
    checkNpmLock(row.lock, { ref, integrity: row.integrity, registry: this.registry });
    return {
      job: this.install(id, {
        preview,
        program: { name: row.program, path: row.programPath },
        kind: "reinstall",
      }),
    };
  }
  status(id) {
    const source = this.servers.get(id).source ?? null;
    const job = this.jobs.get(id);
    const code = job?.state === "failed" ? job.code : (source?.errorCode ?? null);
    if (!code) return { source, job, error: null };
    // Stable code plus the server message and its key; the browser translates the key.
    const { message } = packageProblem(code);
    return { source, job, error: { code, message, ...messageIdentity(message) } };
  }
  start() {
    // A crash can leave preview resolutions behind; no preview survives a restart.
    fs.rmSync(path.join(this.dataDir, "mcp-packages", "previews"), {
      recursive: true,
      force: true,
    });
    for (const row of this.records.all())
      if (row.status === "installing" && !this.jobs.get(row.serverId))
        this.records.update(row.serverId, {
          status: "failed",
          errorCode: "MCP_PACKAGE_INSTALL_FAILED",
        });
    return this.prune();
  }
  /**
   * Removes installs and stages nothing references now, then (in the background, never
   * rejecting) the toolchains no record and no running job uses. Tests await it.
   */
  prune() {
    pruneInstalls(
      this.dataDir,
      new Set([...this.records.installIds(), ...this.jobs.runningInstallIds()]),
    );
    const inUse = [
      ...this.records.all().map((row) => row.toolchainDir),
      ...this.jobs.runningToolchainDirs(),
    ]
      .map((dir) => toolchainEntry(this.dataDir, dir))
      .filter(Boolean);
    return pruneToolchains(this.dataDir, inUse).catch((error) =>
      console.error(
        `AgentPier could not prune MCP package toolchains (${packageCode(error, "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE")}).`,
      ),
    );
  }
}
```

Notes:

- `prune()` runs after every settled job (the `settled` hook), so a failed or aborted job's `.stage-<id>`, the old install after an update and an install committed for a server deleted mid-job are removed as soon as the job ends. Routes call it after `DELETE` and after `detach`; `start()` calls it once at boot. Jobs never await the toolchain part, so a toolchain install holding the serialized queue never delays a job.
- `status()` calls `packageProblem(code)` only with codes from `packageCodes` (job codes come from `packageCode`, record codes from the same source).
- The service lands at about 400 lines (limit 600).

- [ ] **Step 5: Run the jobs test and commit**

Run: `node --test tests/unit/mcp-install-jobs.test.js && npx eslint server/features/mcp-packages`
Expected: PASS, no lint findings. (The service is covered end to end in Task 9.)

```bash
git add server/features/mcp-packages/install-jobs.js server/features/mcp-packages/mcp-packages.js \
  tests/unit/mcp-install-jobs.test.js
git commit -m "feat: run MCP package installs as background jobs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Service integration tests

**Files:**

- Test: `tests/integration/mcp-packages-service.test.js`

**Interfaces:**

- Consumes: `McpPackages` (incl. `attach`, `detach`, `prune`, `status`), `McpServerStore`, `CentralMcpChanges`, `npmRegistryFixture`, `hostNode`, `toolchainTarget`.

- [ ] **Step 1: Write the tests**

```js
// tests/integration/mcp-packages-service.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostNode, npmRegistryFixture } from "../helpers/npm-registry-fixture.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";
import { McpPackages } from "../../server/features/mcp-packages/mcp-packages.js";
import { toolchainTarget } from "../../server/features/mcp-packages/toolchain-manifest.js";

const executeFile = promisify(execFile);
const v1 = {
  name: "server-x",
  version: "1.0.0",
  bin: { "server-x": "index.js" },
  files: { "index.js": "" },
  dependencies: { helper: "1.0.0" },
};
const v2 = { ...v1, version: "2.0.0", dependencies: { helper: "2.0.0" } };
const helpers = [
  { name: "helper", version: "1.0.0", files: { "i.js": "" } },
  { name: "helper", version: "2.0.0", files: { "i.js": "" } },
];
const program =
  /mcp-packages\/installs\/[0-9a-f-]{36}\/node_modules\/server-x\/index\.js$/;
const stored = (extra = {}) => ({
  registry: "npm",
  name: "server-x",
  version: "1.0.0",
  program: "server-x",
  programPath: "index.js",
  allowScripts: false,
  lock: "{}",
  lockDigest: "d".repeat(64),
  integrity: "sha512-x",
  installId: null,
  leadingArgs: 0,
  toolchainDir: null,
  status: "installing",
  errorCode: null,
  ...extra,
});

async function setup(t, published = [v1, v2, ...helpers]) {
  const registry = await npmRegistryFixture(t, published);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-packages-service-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const servers = new McpServerStore({ dataDir });
  // What each reconciliation saw: the definitions right after a stored change.
  const saved = [];
  const changes = new CentralMcpChanges({
    servers,
    onSaved: async () => saved.push(servers.definitions()),
  });
  const node = {
    kind: "node",
    version: "host",
    directory: path.dirname(path.dirname(process.execPath)),
    ...hostNode(),
  };
  // Every npm call's arguments, to tell a resolution from an install.
  const calls = [];
  const packages = new McpPackages({
    dataDir,
    servers,
    changes,
    registry: registry.url,
    download: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw Object.assign(Error("x"), { status: response.status });
      return Buffer.from(await response.arrayBuffer());
    },
    toolchain: async () => node,
    execute: (file, args, options) => {
      calls.push(args);
      return executeFile(file, args, options);
    },
  });
  return { dataDir, servers, changes, packages, saved, calls };
}
const create = async ({ packages }, extra = {}) => {
  const preview = await packages.preview({
    registry: "npm",
    name: "server-x",
    version: "1.0.0",
  });
  const server = await packages.createServer(
    {
      name: "pkg",
      transport: "stdio",
      args: ["--owner"],
      env: { TOKEN: "t" },
      source: { registry: "npm", name: "server-x", version: "1.0.0" },
      ...extra,
    },
    { previewId: preview.previewId },
  );
  return { preview, server };
};
const definitionOf = (snapshot, id) => snapshot.find((d) => d.id === id);

test("create installs, switches the command and keeps owner args", async (t) => {
  const s = await setup(t);
  const { preview, server } = await create(s);
  assert.equal(preview.dependencyCount, 2);
  assert.deepEqual(preview.programs, ["server-x"]);
  assert.equal(server.source.status, "installing");
  assert.equal(server.source.leadingArgs, 0);
  assert.deepEqual(server.args, ["--owner"]);
  // The create's reconciliation already saw the package as installing.
  assert.equal(definitionOf(s.saved[0], server.id).packageStatus, "installing");
  await s.packages.jobs.idle();
  const ready = s.servers.get(server.id);
  assert.equal(ready.source.status, "ready");
  assert.equal(ready.source.leadingArgs, 1);
  assert.equal(ready.command, process.execPath);
  assert.match(ready.args[0], program);
  assert.deepEqual(ready.args.slice(1), ["--owner"]);
  assert.deepEqual(ready.envNames, ["TOKEN"]);
  // The switch's reconciliation saw the package ready with its new command, so the
  // CLIs and agents get the server without another save.
  const last = definitionOf(s.saved.at(-1), server.id);
  assert.equal(last.packageStatus, "ready");
  assert.equal(last.command, process.execPath);
  assert.deepEqual(s.packages.status(server.id).error, null);
});

test("an update shows the diff, switches only on success and removes the old install", async (t) => {
  const s = await setup(t);
  const { server } = await create(s);
  await s.packages.jobs.idle();
  const before = s.servers.get(server.id).args[0];
  const preview = await s.packages.preview({
    registry: "npm",
    name: "server-x",
    version: "2.0.0",
    serverId: server.id,
  });
  assert.deepEqual(preview.diff.changed, [
    { name: "helper", from: "1.0.0", to: "2.0.0" },
    { name: "server-x", from: "1.0.0", to: "2.0.0" },
  ]);
  await s.packages.updatePackage(server.id, {
    version: "2.0.0",
    previewId: preview.previewId,
  });
  await s.packages.jobs.idle();
  const after = s.servers.get(server.id);
  assert.equal(after.source.version, "2.0.0");
  assert.notEqual(after.args[0], before);
  assert.equal(fs.existsSync(before), false);
  assert.deepEqual(after.args.slice(1), ["--owner"]);
});

test("a failed update keeps the previous install active and reports its code", async (t) => {
  const s = await setup(t);
  const { server } = await create(s);
  await s.packages.jobs.idle();
  const before = s.servers.get(server.id);
  const preview = await s.packages.preview({
    registry: "npm",
    name: "server-x",
    version: "2.0.0",
    serverId: server.id,
  });
  s.packages.toolchain = async () => ({
    ...hostNode(),
    npmCliPath: "/nonexistent/npm-cli.js",
  });
  await s.packages.updatePackage(server.id, {
    version: "2.0.0",
    previewId: preview.previewId,
  });
  await s.packages.jobs.idle();
  assert.equal(s.packages.jobs.get(server.id).state, "failed");
  const after = s.servers.get(server.id);
  assert.equal(after.source.status, "ready");
  assert.equal(after.source.version, "1.0.0");
  assert.deepEqual(after.args, before.args);
  const { error } = s.packages.status(server.id);
  assert.equal(error.code, "MCP_PACKAGE_INSTALL_FAILED");
  assert.equal(error.messageKey, "mcpPackages.installFailed");
  // The failed job's stage is gone; only the active install is left.
  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, "mcp-packages", "installs")), [
    s.servers.packages.get(server.id).installId,
  ]);
});

test("a vanished install reports missing and reinstalls from the stored lock", async (t) => {
  const s = await setup(t);
  const { server } = await create(s);
  await s.packages.jobs.idle();
  const lockDigest = s.servers.packages.get(server.id).lockDigest;
  fs.rmSync(path.join(s.dataDir, "mcp-packages", "installs"), { recursive: true });
  assert.equal(s.servers.get(server.id).source.status, "missing");
  s.calls.length = 0;
  s.packages.reinstall(server.id);
  await s.packages.jobs.idle();
  // No new resolution: npm ran `ci` only, and the stored lock is unchanged.
  assert.ok(s.calls.length > 0);
  assert.ok(s.calls.every((args) => !args.includes("--package-lock-only")));
  assert.ok(s.calls.some((args) => args.includes("ci")));
  assert.equal(s.servers.packages.get(server.id).lockDigest, lockDigest);
  assert.equal(s.servers.get(server.id).source.status, "ready");
});

test("a restart during the first install marks it failed", async (t) => {
  const s = await setup(t);
  const server = s.servers.create(
    { name: "pkg", transport: "stdio" },
    { pendingCommand: true, packageRecord: stored() },
  );
  const previews = path.join(s.dataDir, "mcp-packages", "previews", "left-over");
  fs.mkdirSync(previews, { recursive: true });
  await s.packages.start();
  assert.equal(s.servers.get(server.id).source.status, "failed");
  assert.equal(s.servers.get(server.id).source.errorCode, "MCP_PACKAGE_INSTALL_FAILED");
  assert.equal(fs.existsSync(path.dirname(previews)), false);
});

test("an owner edit during the switch is kept and retried once", async (t) => {
  const s = await setup(t);
  const real = s.changes;
  let raced = false;
  // The owner saves (through prepareUpdate, like the PUT route) just before the
  // install's own update, whose revision is then stale (409) and retried.
  s.packages.changes = {
    create: (...args) => real.create(...args),
    update: async (id, input, options) => {
      if (!raced) {
        raced = true;
        const current = s.servers.get(id);
        s.servers.update(
          id,
          s.packages.prepareUpdate(id, {
            revision: current.revision,
            name: "renamed",
            args: ["--edited"],
          }),
        );
      }
      return real.update(id, input, options);
    },
  };
  const { server } = await create(s);
  await s.packages.jobs.idle();
  const after = s.servers.get(server.id);
  assert.equal(raced, true);
  assert.equal(after.name, "renamed");
  assert.equal(after.source.status, "ready");
  assert.equal(after.command, process.execPath);
  assert.match(after.args[0], program);
  assert.deepEqual(after.args.slice(1), ["--edited"]);
});

test("an expired or mismatched preview is refused", async (t) => {
  const s = await setup(t);
  const preview = await s.packages.preview({
    registry: "npm",
    name: "server-x",
    version: "1.0.0",
  });
  await assert.rejects(
    s.packages.createServer(
      {
        name: "pkg",
        transport: "stdio",
        source: { registry: "npm", name: "server-x", version: "2.0.0" },
      },
      { previewId: preview.previewId },
    ),
    { code: "MCP_PACKAGE_PREVIEW_EXPIRED" },
  );
});

test("an own-command server switches to a package and back (D1)", async (t) => {
  const s = await setup(t);
  const own = await s.changes.create(
    { name: "own", transport: "stdio", command: "/bin/sh", args: ["--x"] },
    { confirmStdio: true },
  );
  const preview = await s.packages.preview({
    registry: "npm",
    name: "server-x",
    version: "1.0.0",
  });
  const attached = await s.packages.attach(own.id, {
    source: { registry: "npm", name: "server-x", version: "1.0.0" },
    previewId: preview.previewId,
  });
  assert.equal(attached.source.status, "installing");
  assert.equal(attached.command, "/bin/sh");
  await s.packages.jobs.idle();
  const ready = s.servers.get(own.id);
  assert.equal(ready.source.status, "ready");
  assert.equal(ready.command, process.execPath);
  assert.match(ready.args[0], program);
  assert.deepEqual(ready.args.slice(1), ["--x"]);
  // A packaged server is never attached twice.
  await assert.rejects(
    s.packages.attach(own.id, {
      source: { registry: "npm", name: "server-x", version: "1.0.0" },
      previewId: preview.previewId,
    }),
    { code: "MCP_PACKAGE_INVALID" },
  );
  // Back to an own command: the command switches first, then the record and installs go.
  await s.packages.detach(own.id, () =>
    s.changes.update(
      own.id,
      { revision: ready.revision, command: "/bin/sh", args: ["--x"] },
      { confirmStdio: true },
    ),
  );
  const detached = s.servers.get(own.id);
  assert.equal(detached.source, undefined);
  assert.equal(detached.command, "/bin/sh");
  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, "mcp-packages", "installs")), []);
});

test("unused toolchains are pruned; one a record names by its real path is kept", async (t) => {
  let target;
  try {
    target = toolchainTarget();
  } catch {
    t.skip("no pinned toolchain for this host");
    return;
  }
  const s = await setup(t);
  const root = path.join(s.dataDir, "toolchains");
  const kept = path.join(root, `node-v0.0.1-${target}`);
  const stale = path.join(root, `node-v0.0.2-${target}`);
  fs.mkdirSync(kept, { recursive: true });
  fs.mkdirSync(stale, { recursive: true });
  // os.tmpdir() is /var/... on macOS while realpath gives /private/var/...
  s.servers.create(
    { name: "a", transport: "stdio" },
    {
      pendingCommand: true,
      packageRecord: stored({ toolchainDir: fs.realpathSync(kept) }),
    },
  );
  s.servers.create(
    { name: "b", transport: "stdio" },
    { pendingCommand: true, packageRecord: stored({ toolchainDir: null }) },
  );
  s.servers.create(
    { name: "c", transport: "stdio" },
    { pendingCommand: true, packageRecord: stored({ toolchainDir: "/usr/local" }) },
  );
  await s.packages.prune();
  assert.equal(fs.existsSync(kept), true);
  assert.equal(fs.existsSync(stale), false);
});
```

- [ ] **Step 2: Run the tests and fix what fails**

Run: `node --test tests/integration/mcp-packages-service.test.js`
Expected: PASS (9 tests; the prune test skips only on a host without pinned toolchains). A failure is a defect in the Task 6 or Task 8 code: fix it there, rerun, keep the test unchanged.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/mcp-packages-service.test.js server/features/mcp-packages \
  server/features/mcp-servers
git commit -m "test: cover MCP package install, update, reinstall, attach and recovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: HTTP routes and wiring

**Files:**

- Create: `server/http/routes/mcp-packages.js`
- Modify: `server/http/routes/mcp-servers.js` (`routeProblem`, POST, PUT, DELETE handlers; mount the package routes after `mcpCliRoutes`)
- Modify: `server/features/mcp-packages/package-errors.js` (`MCP_PACKAGE_CONFIRMATION_REQUIRED`), `server/lib/i18n/de/mcp-packages.js`, `server/lib/i18n/en/mcp-packages.js` (`confirmationRequired`)
- Modify: `server/application/services.js:191-206` (create `McpPackages` after `mcpServerChanges`; expose as `services.mcpPackages`)
- Modify: `server/app.js` (next to the `listening` hooks: `server.once("listening", () => services.mcpPackages?.start());`)
- Test: `tests/integration/mcp-packages-routes.test.js`; update `tests/unit/mcp-package-errors.test.js` (15 codes)

**Interfaces:**

- Routes (owner session required like every `/api` route):
  - `GET /api/mcp-packages/versions?registry=&name=` → `{ latest, versions }`.
  - `POST /api/mcp-packages/preview` body `{ registry, name, version, allowScripts, serverId? }` → preview.
  - `POST /api/mcp-servers` with `source` + `previewId` + `confirmInstall: true` (+ optional `program`, `clis`) → `202` public server; without `confirmInstall: true` → `409 { code: "MCP_PACKAGE_CONFIRMATION_REQUIRED" }`.
  - `PUT /api/mcp-servers/:id`:
    - with a `source` object on a server without a record (D1) → needs `confirmInstall: true` (else `409 MCP_PACKAGE_CONFIRMATION_REQUIRED`), refuses a `command` (`400 MCP_PACKAGE_INVALID`), saves the other changed fields (name, args, cwd, env, `clis`) through `changes.update` with the stdio confirmation covered by the install confirmation, then `mcpPackages.attach` → `202` public server; audit `mcp.package.installed`.
    - with a `source` object on a packaged server → `400 MCP_PACKAGE_INVALID` (use `/package/update`).
    - with `source: null` on a packaged server → needs the own `command` in the body (else `400 MCP_PACKAGE_INVALID`); `mcpPackages.detach(id, () => changes.update(...))` (the own command needs `confirmStdio` like any command change) → `200` public server; audit `mcp.package.removed`.
    - otherwise on a packaged server → `mcpPackages.prepareUpdate` (a `command` → `400`; `args` get the generated args in front).
  - `DELETE /api/mcp-servers/:id` → after removal `mcpPackages.prune()`.
  - `POST /api/mcp-servers/:id/package/update` body `{ version, allowScripts, previewId, program, confirmInstall: true }` → `202 { job }`.
  - `POST /api/mcp-servers/:id/package/reinstall` → `202 { job }`.
  - `GET /api/mcp-servers/:id/package` → `{ source, job, error }`.
- Errors: every `MCP_PACKAGE_*` error keeps its status and code on `/mcp-servers/*` too (`routeProblem` passes it through; the global handler adds `messageKey`), so a `502` registry or integrity failure and a `503` toolchain failure reach the browser with their code instead of a logged generic `500` or "assistant unavailable".
- Audit actions: `mcp.package.installed`, `mcp.package.updated`, `mcp.package.reinstalled`, `mcp.package.removed`, details `{ registry, name, version, allowScripts }`.

- [ ] **Step 1: Write the failing route test**

```js
// tests/integration/mcp-packages-routes.test.js
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mcpServerRoutes } from "../../server/http/routes/mcp-servers.js";
import { registerResponses } from "../../server/http/responses.js";
import { packageProblem } from "../../server/features/mcp-packages/package-errors.js";

const source = { registry: "npm", name: "x", version: "1.0.0" };
const packagedServer = { id: "s1", name: "pkg", transport: "stdio", source };

async function app(t, extra = {}) {
  const audit = [];
  const updates = [];
  const services = {
    mcpServerChanges: {
      list: () => [],
      update: async (id, input, options) => {
        updates.push({ id, input, options });
        return { server: { id, transport: "stdio" }, cliChange: null };
      },
      remove: async () => ({ transport: "stdio" }),
    },
    mcpServers: { get: () => packagedServer },
    audit: { append: (entry) => audit.push(entry) },
    ...extra,
  };
  const application = express();
  application.use(express.json());
  application.use("/api", mcpServerRoutes(services));
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const s = application.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const request = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { request, audit, updates };
}

test("creating a packaged server needs the install confirmation", async (t) => {
  const seen = [];
  const { request } = await app(t, {
    mcpPackages: {
      createServer: async (input, options) => {
        seen.push({ input, options });
        return { ...packagedServer, source: { ...source, status: "installing" } };
      },
    },
  });
  const body = { name: "pkg", transport: "stdio", source, previewId: "p" };
  const refused = await request("POST", "/api/mcp-servers", body);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "MCP_PACKAGE_CONFIRMATION_REQUIRED");
  assert.equal(refused.body.messageKey, "mcpPackages.confirmationRequired");
  assert.equal(seen.length, 0);
  const accepted = await request("POST", "/api/mcp-servers", {
    ...body,
    confirmInstall: true,
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(seen[0].options, { previewId: "p", program: undefined });
  assert.equal(seen[0].input.confirmInstall, undefined);
  assert.equal(seen[0].input.previewId, undefined);
});

test("package errors keep their stable code in responses", async (t) => {
  const { request } = await app(t, {
    mcpPackages: {
      versions: async () => {
        throw packageProblem("MCP_PACKAGE_NOT_FOUND", 404);
      },
      reinstall: () => {
        throw packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
      },
      updatePackage: async () => {
        throw packageProblem("MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE", 503);
      },
    },
  });
  const missing = await request(
    "GET",
    "/api/mcp-packages/versions?registry=npm&name=nope",
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "MCP_PACKAGE_NOT_FOUND");
  const integrity = await request("POST", "/api/mcp-servers/s1/package/reinstall", {});
  assert.equal(integrity.status, 502);
  assert.equal(integrity.body.code, "MCP_PACKAGE_INTEGRITY_MISMATCH");
  const toolchain = await request("POST", "/api/mcp-servers/s1/package/update", {
    version: "2.0.0",
    previewId: "p",
    confirmInstall: true,
  });
  assert.equal(toolchain.status, 503);
  assert.equal(toolchain.body.code, "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE");
});

test("the audit records package name and version, never env or args", async (t) => {
  const { request, audit } = await app(t, {
    mcpPackages: {
      createServer: async () => ({
        ...packagedServer,
        source: { ...source, status: "installing" },
      }),
    },
  });
  await request("POST", "/api/mcp-servers", {
    name: "pkg",
    transport: "stdio",
    args: ["--secret-arg"],
    env: { TOKEN: "abc" },
    source: { ...source, allowScripts: true },
    previewId: "p",
    confirmInstall: true,
  });
  assert.equal(audit.at(-1).action, "mcp.package.installed");
  assert.deepEqual(audit.at(-1).details, {
    registry: "npm",
    name: "x",
    version: "1.0.0",
    allowScripts: true,
  });
  assert.doesNotMatch(JSON.stringify(audit), /secret-arg|abc/);
});

test("an own-command server switches to a package only with the confirmation (D1)", async (t) => {
  const attached = [];
  const { request, updates, audit } = await app(t, {
    mcpPackages: {
      isPackaged: () => false,
      attach: async (id, options, beforeInstall) => {
        attached.push({ id, options });
        await beforeInstall?.();
        return { ...packagedServer, source: { ...source, status: "installing" } };
      },
    },
  });
  const body = { revision: 3, source, previewId: "p", args: ["--x"] };
  const refused = await request("PUT", "/api/mcp-servers/s1", body);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "MCP_PACKAGE_CONFIRMATION_REQUIRED");
  const command = await request("PUT", "/api/mcp-servers/s1", {
    ...body,
    command: "/bin/sh",
    confirmInstall: true,
  });
  assert.equal(command.status, 400);
  assert.equal(command.body.code, "MCP_PACKAGE_INVALID");
  assert.equal(attached.length, 0);
  const accepted = await request("PUT", "/api/mcp-servers/s1", {
    ...body,
    confirmInstall: true,
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(attached[0], {
    id: "s1",
    options: { source, previewId: "p", program: undefined },
  });
  // The other edits go through the normal update first, confirmed by the install.
  assert.deepEqual(updates, [
    { id: "s1", input: { revision: 3, args: ["--x"] }, options: { confirmStdio: true } },
  ]);
  assert.equal(audit.at(-1).action, "mcp.package.installed");
});

test("a packaged server refuses a new source and detaches only to an own command", async (t) => {
  const detached = [];
  const { request, updates, audit } = await app(t, {
    mcpPackages: {
      isPackaged: () => true,
      detach: async (id, update) => {
        await update();
        detached.push(id);
      },
    },
  });
  const again = await request("PUT", "/api/mcp-servers/s1", {
    revision: 3,
    source,
    previewId: "p",
    confirmInstall: true,
  });
  assert.equal(again.status, 400);
  assert.equal(again.body.code, "MCP_PACKAGE_INVALID");
  const bare = await request("PUT", "/api/mcp-servers/s1", { revision: 3, source: null });
  assert.equal(bare.status, 400);
  assert.equal(bare.body.code, "MCP_PACKAGE_INVALID");
  const own = await request("PUT", "/api/mcp-servers/s1", {
    revision: 3,
    source: null,
    command: "/bin/sh",
    confirmStdio: true,
  });
  assert.equal(own.status, 200);
  assert.deepEqual(detached, ["s1"]);
  assert.deepEqual(updates, [
    {
      id: "s1",
      input: { revision: 3, command: "/bin/sh" },
      options: { confirmStdio: true },
    },
  ]);
  assert.equal(audit.at(-1).action, "mcp.package.removed");
});

test("an edit of a packaged server goes through prepareUpdate; delete prunes", async (t) => {
  let pruned = 0;
  const { request, updates } = await app(t, {
    mcpPackages: {
      prepareUpdate: (_id, input) => ({
        ...input,
        args: ["/gen/index.js", ...input.args],
      }),
      prune: async () => {
        pruned += 1;
      },
    },
  });
  const edited = await request("PUT", "/api/mcp-servers/s1", {
    revision: 3,
    args: ["--owner"],
    confirmStdio: true,
  });
  assert.equal(edited.status, 200);
  assert.deepEqual(updates[0].input, { revision: 3, args: ["/gen/index.js", "--owner"] });
  const removed = await request("DELETE", "/api/mcp-servers/s1");
  assert.equal(removed.status, 204);
  assert.equal(pruned, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/integration/mcp-packages-routes.test.js`
Expected: FAIL (routes missing; unknown code `MCP_PACKAGE_CONFIRMATION_REQUIRED`).

- [ ] **Step 3: Add the confirmation code**

`server/features/mcp-packages/package-errors.js` `keys`: add `MCP_PACKAGE_CONFIRMATION_REQUIRED: "confirmationRequired",` after `MCP_PACKAGE_BUSY`. Catalogs (same key in both):

- `server/lib/i18n/de/mcp-packages.js`: `confirmationRequired: "Bitte die Installation des Pakets bestätigen.",`
- `server/lib/i18n/en/mcp-packages.js`: `confirmationRequired: "Please confirm the installation of the package.",`

`tests/unit/mcp-package-errors.test.js`: change `assert.equal(packageCodes.length, 14);` to `assert.equal(packageCodes.length, 15);`.

- [ ] **Step 4: Implement routes and wiring**

```js
// server/http/routes/mcp-packages.js
import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { record } from "../../features/extensions/mcp-config.js";
import { packageProblem } from "../../features/mcp-packages/package-errors.js";

const invalid = () => packageProblem("MCP_PACKAGE_INVALID", 400);
/** One owner confirmation per install; it replaces the stdio confirmation. */
export const requireInstallConfirmation = (body) => {
  if (body?.confirmInstall !== true)
    throw packageProblem("MCP_PACKAGE_CONFIRMATION_REQUIRED", 409);
};
export const auditDetails = (source) => ({
  registry: source?.registry,
  name: source?.name,
  version: source?.version,
  allowScripts: source?.allowScripts === true,
});
const packagesOf = (services) => {
  if (!services.mcpPackages) throw assistantProblem("unavailable", 503);
  return services.mcpPackages;
};

/**
 * `PUT /mcp-servers/:id` with `source`: `null` detaches a packaged server to the own
 * command in the body; an object switches an own-command server to a package (D1).
 */
export async function changeSource(services, { changes, auditMcp }, req, res) {
  const packages = packagesOf(services);
  const id = req.params.id;
  const {
    confirmStdio,
    confirmInstall: _confirm,
    clis,
    source,
    previewId,
    program,
    ...patch
  } = req.body;
  const options = {
    confirmStdio: confirmStdio === true,
    ...(clis === undefined ? {} : { clis }),
  };
  if (source === null) {
    if (!packages.isPackaged(id) || typeof patch.command !== "string") throw invalid();
    const before = services.mcpServers.get(id).source;
    await packages.detach(id, () => changes().update(id, patch, options));
    auditMcp("mcp.package.removed", id, auditDetails(before));
    return res.json(services.mcpServers.get(id));
  }
  if (!record(source) || packages.isPackaged(id) || patch.command !== undefined)
    throw invalid();
  requireInstallConfirmation(req.body);
  const edits =
    Object.keys(patch).some((key) => key !== "revision") || clis !== undefined;
  // The install confirmation covers the other stdio fields saved with it.
  const server = await packages.attach(
    id,
    { source, previewId, program },
    edits
      ? () => changes().update(id, patch, { ...options, confirmStdio: true })
      : undefined,
  );
  auditMcp("mcp.package.installed", id, auditDetails(source));
  return res.status(202).json(server);
}

export function mcpPackageRoutes(services, { auditMcp }) {
  const packages = () => packagesOf(services);
  const router = Router();
  router.get("/mcp-packages/versions", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(
      await packages().versions({ registry: req.query.registry, name: req.query.name }),
    );
  });
  router.post("/mcp-packages/preview", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await packages().preview(record(req.body) ? req.body : {}));
  });
  router.get("/mcp-servers/:id/package", (req, res) =>
    res.json(packages().status(req.params.id)),
  );
  router.post("/mcp-servers/:id/package/update", async (req, res) => {
    const body = record(req.body) ? req.body : {};
    requireInstallConfirmation(body);
    const result = await packages().updatePackage(req.params.id, body);
    const current = services.mcpServers.get(req.params.id).source;
    auditMcp(
      "mcp.package.updated",
      req.params.id,
      auditDetails({
        ...current,
        version: body.version,
        allowScripts: body.allowScripts,
      }),
    );
    res.status(202).json(result);
  });
  router.post("/mcp-servers/:id/package/reinstall", (req, res) => {
    const result = packages().reinstall(req.params.id);
    auditMcp(
      "mcp.package.reinstalled",
      req.params.id,
      auditDetails(services.mcpServers.get(req.params.id).source),
    );
    res.status(202).json(result);
  });
  return router;
}
```

`server/http/routes/mcp-servers.js` edits:

- Imports: `import { auditDetails, changeSource, mcpPackageRoutes, requireInstallConfirmation } from "./mcp-packages.js";`
- `routeProblem`, first line of the function body:

```js
// Package problems keep their status and code (502 registry, 503 toolchain).
if (/^MCP_PACKAGE_/.test(error?.code || "")) return error;
```

- Mount: `router.use(mcpPackageRoutes(services, { auditMcp }));` right after `router.use(mcpCliRoutes(...))`. `/mcp-packages/*` errors reach the global handler, `/mcp-servers/:id/package*` errors pass `mcpServerErrors`; both keep `MCP_PACKAGE_*` codes.
- POST handler, right after `const { confirmStdio, clis, ...input } = record(body) ? body : {};`:

```js
if (record(body) && body.source !== undefined) {
  // The install confirmation replaces the stdio confirmation for this save.
  requireInstallConfirmation(body);
  const { confirmInstall: _confirm, previewId, program, ...definition } = input;
  if (!services.mcpPackages) throw assistantProblem("unavailable", 503);
  let created;
  try {
    created = await services.mcpPackages.createServer(definition, {
      previewId,
      program,
      ...(clis === undefined ? {} : { clis }),
    });
  } catch (error) {
    if (replyValueReference(res, error)) return;
    throw error;
  }
  auditMcp("mcp.package.installed", created.id, auditDetails(body.source));
  return res.status(202).json(created);
}
```

- PUT handler: the whole handler becomes

```js
router.put("/mcp-servers/:id", async (req, res) => {
  const body = req.body;
  try {
    if (record(body) && body.source !== undefined)
      return await changeSource(services, { changes, auditMcp }, req, res);
    const { confirmStdio, clis, ...rest } = record(body) ? body : {};
    // A packaged server keeps its generated command; owner args follow the generated ones.
    const input =
      record(body) && services.mcpPackages
        ? services.mcpPackages.prepareUpdate(req.params.id, rest)
        : rest;
    const { server, pending, logoutDeferred, stdioChanged, cliChange } =
      await changes().update(req.params.id, record(body) ? input : body, {
        confirmStdio: confirmStdio === true,
        ...(clis === undefined ? {} : { clis }),
      });
    // The owner confirmed a local command that changed or now runs in a new CLI.
    const newCli = server.transport === "stdio" && cliChange?.added.length > 0;
    auditMcp("mcp.updated", server.id, {
      transport: server.transport,
      fields: [
        ...Object.keys(record(body) ? input : {}).filter((key) => key !== "revision"),
        ...(cliChange ? ["clis"] : []),
      ],
      ...(cliChange ? { clis: cliChange.clis } : {}),
      stdioConfirmed: (stdioChanged || newCli) && confirmStdio === true,
    });
    res.json({
      ...server,
      ...(pending ? { pending: true } : {}),
      ...(logoutDeferred ? { oauthWarning: deferredWarning() } : {}),
    });
  } catch (error) {
    if (replyStdioConfirmation(res, error) || replyValueReference(res, error)) return;
    throw error;
  }
});
```

The audit and the response are today's code; `input` (after `prepareUpdate`) has the same keys as the owner's patch, so the audited field names do not change.

- DELETE handler: after `await changes().remove(req.params.id)`, add `services.mcpPackages?.prune();` (it never rejects; the response does not wait for toolchain pruning).

`services.js` after `mcpServerChanges` (line 206):

```js
const mcpPackages =
  mcpServers &&
  new McpPackages({
    dataDir: config.dataDir,
    servers: mcpServers,
    changes: mcpServerChanges,
  });
```

and include `mcpPackages` in the returned `services` object next to `mcpServerChanges`. Import `McpPackages` from `../features/mcp-packages/mcp-packages.js`.

`app.js`, beside the other `listening` hooks: `server.once("listening", () => services.mcpPackages?.start());`

- [ ] **Step 5: Run tests**

Run: `node --test tests/integration/mcp-packages-routes.test.js tests/unit/mcp-package-errors.test.js tests/unit/server-i18n-catalogs.test.js tests/unit/mcp-settings-routes.test.js tests/unit/mcp-route-errors.test.js && npx eslint server/http/routes server/application/services.js server/app.js`
Expected: PASS, no lint findings.

- [ ] **Step 6: Commit**

```bash
git add server/http/routes/mcp-packages.js server/http/routes/mcp-servers.js server/application/services.js \
  server/app.js server/features/mcp-packages/package-errors.js server/lib/i18n/de/mcp-packages.js \
  server/lib/i18n/en/mcp-packages.js tests/integration/mcp-packages-routes.test.js \
  tests/unit/mcp-package-errors.test.js
git commit -m "feat: serve MCP package preview, install, update, reinstall and source switches

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Form, confirmation and status panel

**Files:**

- Create: `web/lib/i18n/de/mcp-packages.js`, `web/lib/i18n/en/mcp-packages.js`, `web/lib/i18n/messages/mcp-packages.js`
- Modify: `web/features/assistants/assistant-api.js:103-111`
- Modify: `web/features/mcp-servers/mcp-server-draft.js` (`draftFrom`, `requestBody`)
- Modify: `web/features/mcp-servers/mcp-server-save.js` (`mcpServerStep`)
- Create: `web/features/mcp-servers/useMcpPackageVersions.js`, `McpPackageFields.jsx`, `McpPackageConfirmation.jsx`, `McpPackagePanel.jsx`
- Modify: `web/features/mcp-servers/McpServerFields.jsx` (source switch inside the stdio branch), `McpServerDetail.jsx` (confirmation kind `package`, panel)
- Test: extend `tests/unit/mcp-server-draft.test.js`, `tests/unit/mcp-server-save.test.js`; create `tests/browser/mcp-packages.spec.js`

**Interfaces:**

- API (`assistantApi`): `mcpPackageVersions(registry, name)` → GET versions; `previewMcpPackage(input)` → POST preview; `mcpPackageStatus(id)`; `updateMcpPackage(id, input)`; `reinstallMcpPackage(id)`.
- Draft fields: `source: "command" | "package"`, `registry: "npm"`, `packageName`, `packageVersion`, `allowScripts`, `program`; for a packaged server `args` shows only owner args: always `server.args.slice(server.source.leadingArgs)` (the server reports `leadingArgs: 0` until a first install stored a generated argument, so `ready`, `missing`, `failed` and `installing` all slice correctly and an edit never sends a generated argument back).
- Body for an existing own-command stdio server switched to **Install package** (D1): `source` plus the changed fields, never `command`; the route attaches the package.
- `mcpServerStep({ …, previewPackage, chosenProgram })`: for a stdio server whose draft source is `package` and that has no `source` yet (new server, or an own-command server switching, D1) without `confirmations.confirmInstall` it calls `previewPackage` and throws code `MCP_PACKAGE_INSTALL_REQUIRED` with `preview`; `confirmation` maps it to `{ kind: "package", flags: { confirmInstall: true, previewId }, data: { preview } }`. `chosenProgram()` returns the program the confirmation dialog selected (or `null`); the body then carries `program`. (`confirmation.confirm()` in `web/lib/settings/useTabDraft.js` takes no arguments, so the choice travels through this callback.)

- [ ] **Step 1: Copy (German and English, same keys)**

```js
// web/lib/i18n/en/mcp-packages.js
export const mcpPackageCopy = {
  sourceLabel: "Source",
  sources: { command: "Own command", package: "Install package" },
  registryLabel: "Registry",
  registries: { npm: "npm" },
  nameLabel: "Package",
  versionLabel: "Version",
  versionsLoading: "Loading versions…",
  versionsUnavailable:
    "Versions could not be loaded. Check the package name or try again later.",
  showPrereleases: "Show prereleases",
  prerelease: "prerelease",
  deprecated: "deprecated",
  installed: "installed",
  allowScripts: "Allow install scripts or source builds",
  allowScriptsWarning:
    "Package code then runs during installation with your user's rights. Allow it only for packages you trust.",
  confirmTitle: "Install this package?",
  confirmAction: "Install",
  updateAction: "Update",
  dependencies: (count) => `${count} packages in total`,
  integrity: "Integrity",
  programLabel: "Program",
  needsScripts: "This package needs install scripts or a source build.",
  diffAdded: "Added",
  diffRemoved: "Removed",
  diffChanged: "Changed",
  status: {
    installing: "Installing…",
    ready: "Installed",
    failed: "Installation failed",
    missing: "Installation missing",
  },
  reinstall: "Reinstall",
  checkUpdate: "Check update",
  log: "Installation log",
  versionAt: (version, date) => `${version} · ${date}`,
};
```

`web/lib/i18n/de/mcp-packages.js` with the same keys:

```js
export const mcpPackageCopy = {
  sourceLabel: "Quelle",
  sources: { command: "Eigener Befehl", package: "Paket installieren" },
  registryLabel: "Registry",
  registries: { npm: "npm" },
  nameLabel: "Paket",
  versionLabel: "Version",
  versionsLoading: "Versionen werden geladen…",
  versionsUnavailable:
    "Die Versionen konnten nicht geladen werden. Prüfe den Paketnamen oder versuche es später erneut.",
  showPrereleases: "Vorabversionen anzeigen",
  prerelease: "Vorabversion",
  deprecated: "veraltet",
  installed: "installiert",
  allowScripts: "Installationsskripte oder Builds aus dem Quellcode erlauben",
  allowScriptsWarning:
    "Dann läuft Code aus dem Paket bei der Installation mit den Rechten deines Benutzers. Erlaube das nur für Pakete, denen du vertraust.",
  confirmTitle: "Dieses Paket installieren?",
  confirmAction: "Installieren",
  updateAction: "Aktualisieren",
  dependencies: (count) => `${count} Pakete insgesamt`,
  integrity: "Integrität",
  programLabel: "Programm",
  needsScripts:
    "Dieses Paket braucht Installationsskripte oder einen Build aus dem Quellcode.",
  diffAdded: "Hinzugefügt",
  diffRemoved: "Entfernt",
  diffChanged: "Geändert",
  status: {
    installing: "Wird installiert…",
    ready: "Installiert",
    failed: "Installation fehlgeschlagen",
    missing: "Installation fehlt",
  },
  reinstall: "Neu installieren",
  checkUpdate: "Update prüfen",
  log: "Installationsprotokoll",
  versionAt: (version, date) => `${version} · ${date}`,
};
```

`web/lib/i18n/messages/mcp-packages.js`:

```js
import * as de from "../de/mcp-packages.js";
import * as en from "../en/mcp-packages.js";
import { localizedCopy } from "../index.js";
export const mcpPackageCopy = localizedCopy(de.mcpPackageCopy, en.mcpPackageCopy);
```

Error codes reach the browser with the German server message and `messageKey` (existing `messageIdentity`): save errors through the save chain, and the panel's job error through `status.error` (`{ code, message, messageKey }` from `GET /mcp-servers/:id/package`), shown with `serverText(error.message, error.messageKey)` from `web/lib/server-messages.js`. No extra browser copy is needed for them.

- [ ] **Step 2: Draft and save tests (failing first)**

The test files already import `draftFrom` and `requestBody` (draft test) and `mcpServerStep` and `mcpServerValues` (save test); add only the tests.

```js
// add to tests/unit/mcp-server-draft.test.js
test("a new packaged server sends its source and no command", () => {
  const draft = {
    ...draftFrom(null),
    transport: "stdio",
    name: "pkg",
    source: "package",
    registry: "npm",
    packageName: "server-x",
    packageVersion: "1.0.0",
    args: "--owner",
  };
  assert.deepEqual(requestBody(draft, null), {
    name: "pkg",
    transport: "stdio",
    args: ["--owner"],
    source: { registry: "npm", name: "server-x", version: "1.0.0", allowScripts: false },
  });
});

test("a ready packaged server shows only the owner's arguments", () => {
  const draft = draftFrom({
    name: "pkg",
    transport: "stdio",
    command: "/data/toolchains/node/bin/node",
    args: ["/data/mcp-packages/installs/i/node_modules/x/index.js", "--owner"],
    source: {
      registry: "npm",
      name: "x",
      version: "1.0.0",
      status: "ready",
      leadingArgs: 1,
    },
    headerNames: [],
    envNames: [],
    revision: 3,
  });
  assert.equal(draft.source, "package");
  assert.equal(draft.args, "--owner");
});

test("a missing or failed packaged server still hides its generated argument", () => {
  for (const status of ["missing", "failed"]) {
    const draft = draftFrom({
      name: "pkg",
      transport: "stdio",
      command: "/data/toolchains/node/bin/node",
      args: ["/data/mcp-packages/installs/i/node_modules/x/index.js", "--owner"],
      source: { registry: "npm", name: "x", version: "1.0.0", status, leadingArgs: 1 },
      headerNames: [],
      envNames: [],
      revision: 3,
    });
    assert.equal(draft.args, "--owner", status);
  }
});

test("an own-command server switched to a package sends its source, never a command", () => {
  const server = {
    id: "s1",
    name: "own",
    transport: "stdio",
    command: "/bin/sh",
    args: ["--x"],
    headerNames: [],
    envNames: [],
    revision: 4,
  };
  const draft = {
    ...draftFrom(server),
    source: "package",
    registry: "npm",
    packageName: "server-x",
    packageVersion: "1.0.0",
  };
  assert.deepEqual(requestBody(draft, server), {
    revision: 4,
    source: { registry: "npm", name: "server-x", version: "1.0.0", allowScripts: false },
  });
});
```

```js
// add to tests/unit/mcp-server-save.test.js
test("a new packaged server asks for the install confirmation with its preview", async () => {
  const preview = { previewId: "p1", programs: ["a", "b"], dependencyCount: 3 };
  const step = mcpServerStep({
    server: null,
    label: "Save",
    saved: async () => {},
    previewPackage: async () => preview,
    saveServer: async () => assert.fail("must not save before confirmation"),
  });
  const values = {
    ...mcpServerValues(null),
    name: "pkg",
    transport: "stdio",
    source: "package",
    packageName: "x",
    packageVersion: "1.0.0",
  };
  await assert.rejects(step.run({ values, confirmations: {} }), (error) => {
    assert.equal(error.code, "MCP_PACKAGE_INSTALL_REQUIRED");
    assert.deepEqual(step.confirmation(error), {
      kind: "package",
      flags: { confirmInstall: true, previewId: "p1" },
      data: { preview },
    });
    return true;
  });
});

test("an own-command server switching to a package is previewed and sent with its source", async () => {
  const server = {
    id: "s1",
    name: "own",
    transport: "stdio",
    command: "/bin/sh",
    args: [],
    headerNames: [],
    envNames: [],
    revision: 4,
    clis: [],
  };
  const sent = [];
  const step = mcpServerStep({
    server,
    label: "Save",
    saved: async () => {},
    previewPackage: async () => ({ previewId: "p2", programs: ["x"] }),
    saveServer: async (_server, body) => {
      sent.push(body);
      return { ...server, source: { status: "installing" } };
    },
  });
  const values = {
    ...mcpServerValues(server),
    source: "package",
    packageName: "x",
    packageVersion: "1.0.0",
  };
  await assert.rejects(step.run({ values, revision: 4, confirmations: {} }), {
    code: "MCP_PACKAGE_INSTALL_REQUIRED",
  });
  await step.run({
    values,
    revision: 4,
    confirmations: { confirmInstall: true, previewId: "p2" },
  });
  assert.equal(sent[0].command, undefined);
  assert.deepEqual(sent[0].source, {
    registry: "npm",
    name: "x",
    version: "1.0.0",
    allowScripts: false,
  });
  assert.equal(sent[0].confirmInstall, true);
  assert.equal(sent[0].previewId, "p2");
});
```

Run: `node --test tests/unit/mcp-server-draft.test.js tests/unit/mcp-server-save.test.js` → FAIL.

- [ ] **Step 3: Implement draft, save and API**

`assistant-api.js` additions:

```js
  mcpPackageVersions: (registry, name) =>
    api(`/mcp-packages/versions?registry=${encodeURIComponent(registry)}&name=${encodeURIComponent(name)}`),
  previewMcpPackage: (input) => api("/mcp-packages/preview", "POST", input),
  mcpPackageStatus: (id) => api(`/mcp-servers/${encodeURIComponent(id)}/package`),
  updateMcpPackage: (id, input) =>
    api(`/mcp-servers/${encodeURIComponent(id)}/package/update`, "POST", input),
  reinstallMcpPackage: (id) =>
    api(`/mcp-servers/${encodeURIComponent(id)}/package/reinstall`, "POST", {}),
```

`mcp-server-draft.js` `draftFrom(server)` additions:

```js
    source: server?.source ? "package" : "command",
    registry: server?.source?.registry || "npm",
    packageName: server?.source?.name || "",
    packageVersion: server?.source?.version || "",
    allowScripts: server?.source?.allowScripts === true,
    // The server reports leadingArgs 0 until a generated argument is stored.
    args: (server?.args || []).slice(server?.source?.leadingArgs ?? 0).join("\n"),
```

(replacing the existing `args:` line). In `requestBody`:

```js
const packaged = stdio && draft.source === "package";
const packageSource = () => ({
  registry: draft.registry,
  name: draft.packageName.trim(),
  version: draft.packageVersion,
  allowScripts: draft.allowScripts === true,
});
```

- New server: inside the `stdio` branch replace `command: draft.command.trim(),` by `...(packaged ? { source: packageSource() } : { command: draft.command.trim() }),`.
- Existing server: replace `...(changed("command") ? { command: draft.command.trim() } : {}),` by `...(!packaged && changed("command") ? { command: draft.command.trim() } : {}),` and add after it `...(packaged && !server.source ? { source: packageSource() } : {}),` (D1: an own-command server switching; a packaged server's source changes only through `/package/update`).

`mcp-server-save.js` `mcpServerStep({ server, label, saveServer = defaultSave, previewPackage = assistantApi.previewMcpPackage, chosenProgram = () => null, saved })`:

```js
export const PACKAGE_INSTALL_REQUIRED = "MCP_PACKAGE_INSTALL_REQUIRED";
// in run(), before building body:
      // A new server, or an own-command server switching to a package (D1).
      const installing =
        values.transport === "stdio" && values.source === "package" && !server?.source;
      if (installing && !confirmations.confirmInstall) {
        const preview = await previewPackage({
          registry: values.registry,
          name: values.packageName.trim(),
          version: values.packageVersion,
          allowScripts: values.allowScripts === true,
        });
        throw Object.assign(question(PACKAGE_INSTALL_REQUIRED), { preview });
      }
      // a packaged server needs no separate CLI stdio question: the install confirmation covers it
      if (!installing && values.transport === "stdio" && added.length && !confirmations.confirmStdio)
        throw question(CLI_STDIO_REQUIRED);
      const body = {
        ...requestBody(values, server),
        ...(server ? { revision } : {}),
        ...(clisChanged ? { clis: wanted } : {}),
        ...(confirmations.confirmStdio ? { confirmStdio: true } : {}),
        ...(installing
          ? {
              confirmInstall: true,
              previewId: confirmations.previewId,
              ...(chosenProgram?.() ? { program: chosenProgram() } : {}),
            }
          : {}),
      };
// confirmation:
      error?.code === PACKAGE_INSTALL_REQUIRED
        ? {
            kind: "package",
            flags: { confirmInstall: true, previewId: error.preview.previewId },
            data: { preview: error.preview },
          }
        : /* existing chain */
```

In `McpServerDetail.jsx` keep `const programChoice = useRef(null);` and pass `chosenProgram: () => programChoice.current` to `mcpServerStep`. The dialog's `onConfirm(program)` sets `programChoice.current = program` and then calls `confirmation.confirm()`.

Run: `node --test tests/unit/mcp-server-draft.test.js tests/unit/mcp-server-save.test.js` → PASS.

- [ ] **Step 4: Components**

`useMcpPackageVersions.js`:

```js
import { useEffect, useState } from "react";
import { assistantApi } from "../assistants/assistant-api.js";

/** Versions of `name` in `registry`, fetched 400 ms after the name settles. */
export default function useMcpPackageVersions(registry, name) {
  const [state, setState] = useState({
    loading: false,
    failed: false,
    latest: null,
    versions: [],
  });
  useEffect(() => {
    const trimmed = name.trim();
    if (!trimmed)
      return setState({ loading: false, failed: false, latest: null, versions: [] });
    let live = true;
    setState((s) => ({ ...s, loading: true, failed: false }));
    const timer = setTimeout(() => {
      assistantApi
        .mcpPackageVersions(registry, trimmed)
        .then((result) => live && setState({ loading: false, failed: false, ...result }))
        .catch(
          () =>
            live &&
            setState({ loading: false, failed: true, latest: null, versions: [] }),
        );
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [registry, name]);
  return state;
}
```

`McpServerFields.jsx`, stdio branch: a `Segment` labelled `copy.sourceLabel` with `copy.sources` (`command`, `package`) sits above the command field. It is editable for a new server and for an existing own-command server (D1: `server && !server.source`); once a server is packaged (`server?.source`) it is replaced by read-only text `copy.sources.package` (switching back is the API's `source: null`, not offered in this form). When `values.source === "package"` the command field is hidden and `McpPackageFields` renders instead.

`McpPackageFields.jsx`: registry `Segment` (`["npm"]`), package name input (`autoCapitalize="none"`, `spellCheck={false}`), a `<select>` for the version whose options are `versions.filter((v) => showPrereleases || !v.prerelease)` labelled `copy.versionAt(v.version, new Date(v.publishedAt).toLocaleDateString())` plus ` · ${copy.deprecated}` when deprecated; preselect `latest` when the draft has no version (`useEffect` setting `set("packageVersion")(latest)`); a "Show prereleases" checkbox; the loading/failed hint (`role="status"`); the `allowScripts` checkbox with `copy.allowScriptsWarning` in a `.mcp-warning` paragraph when checked. Then the existing args, cwd and env fields.

`McpPackageConfirmation.jsx`: an `alertdialog` like `StdioConfirmation` (reuse `useAlertDialogFocus`), title `copy.confirmTitle` (or `copy.updateAction` for updates), `name@version`, registry, integrity (first 24 characters + "…"), `copy.dependencies(preview.dependencyCount)` in a `<details>` listing `name version`, a program `<select>` when `preview.programs.length > 1`, the warning when `allowScripts`, `copy.needsScripts` when `preview.needsScripts && !allowScripts` (confirm disabled), the diff (three lists) when `preview.diff`, and Confirm/Cancel buttons.

`McpPackagePanel.jsx` in `McpServerDetail` above the form for a packaged server: `copy.status[source.status]` (with `role="status"`), `name@version`, the error of the last failed job or the record (`status.error` from `mcpPackageStatus(id)`, rendered as `serverText(status.error.message, status.error.messageKey)` in a `role="alert"` paragraph), `<details><summary>{copy.log}</summary><pre>{job.log}</pre></details>`, **Reinstall** when status is `failed` or `missing`, and an update row (version select from `useMcpPackageVersions`, **Check update** → `previewMcpPackage({ …, serverId })` → `McpPackageConfirmation` with the diff → `updateMcpPackage`). While `source.status === "installing"` or `job.state === "running"`, poll `mcpPackageStatus` every 2 s and call `data.reloadMcp()` when it settles.

In `McpServerDetail.jsx` add `{confirmation?.kind === "package" && <McpPackageConfirmation preview={confirmation.data.preview} allowScripts={draft.values.allowScripts} onConfirm={(program) => { programChoice.current = program ?? null; confirmation.confirm(); }} onCancel={confirmation.cancel} />}` beside the stdio confirmations.

- [ ] **Step 5: Browser test**

```js
// tests/browser/mcp-packages.spec.js
import { test, expect } from "@playwright/test";
import { accountDetail } from "../helpers/accounts-browser.js";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

async function setup(page) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = { requests: [], servers: [] };
  await page.route(/\/api\/mcp-packages\/versions/, (route) =>
    route.fulfill({
      json: {
        latest: "1.1.0",
        versions: [
          {
            version: "2.0.0-rc.1",
            publishedAt: "2026-10-01T00:00:00Z",
            prerelease: true,
            deprecated: false,
          },
          {
            version: "1.1.0",
            publishedAt: "2026-09-01T00:00:00Z",
            prerelease: false,
            deprecated: false,
          },
          {
            version: "1.0.0",
            publishedAt: "2026-08-01T00:00:00Z",
            prerelease: false,
            deprecated: true,
          },
        ],
      },
    }),
  );
  await page.route(/\/api\/mcp-packages\/preview/, (route) => {
    state.requests.push({ path: "preview", body: route.request().postDataJSON() });
    return route.fulfill({
      json: {
        previewId: "p1",
        registry: "npm",
        name: "server-x",
        version: "1.1.0",
        integrity: "sha512-abcdefghijklmnopqrstuvwxyz",
        dependencyCount: 2,
        dependencies: [
          { name: "helper", version: "1.0.0" },
          { name: "server-x", version: "1.1.0" },
        ],
        programs: ["server-x"],
        needsScripts: false,
        diff: null,
      },
    });
  });
  // Only the list and one server here; the package status has its own route below.
  await page.route(/\/api\/mcp-servers(\/[^/]+)?$/, (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: state.servers });
    const body = request.postDataJSON();
    state.requests.push({ path: "servers", body });
    const server = {
      id: "s1",
      name: body.name,
      transport: "stdio",
      args: body.args || [],
      headerNames: [],
      envNames: [],
      revision: 1,
      // Before its first install the server reports no generated argument.
      source: { ...body.source, status: "installing", leadingArgs: 0, errorCode: null },
    };
    state.servers = [server];
    return route.fulfill({ status: 202, json: server });
  });
  await page.route(/\/api\/mcp-servers\/[^/]+\/package$/, (route) =>
    route.fulfill({
      json: {
        source: state.servers[0]?.source ?? null,
        job: { kind: "install", state: "running", code: null, log: "" },
        error: null,
      },
    }),
  );
  return state;
}

test("installing an npm package previews, confirms once and shows progress", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(baseURL + "/accounts");
  const panel = page.getByRole("region", { name: "MCP servers" });
  await panel.getByRole("button", { name: "Add MCP server" }).click();
  const dialog = accountDetail(page);
  await dialog.getByLabel("Name", { exact: true }).fill("pkg");
  await dialog.getByRole("radio", { name: "Local command (stdio)" }).check();
  await dialog.getByRole("radio", { name: "Install package" }).check();
  // exact: "Install package" (the source radio) also contains "Package".
  await dialog.getByLabel("Package", { exact: true }).fill("server-x");
  const version = dialog.getByLabel("Version");
  await expect(version).toHaveValue("1.1.0");
  await expect(version.locator("option")).toHaveCount(2);
  await dialog.getByLabel("Show prereleases").check();
  await expect(version.locator("option")).toHaveCount(3);
  await dialog.getByRole("button", { name: "Save server" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Install this package?" });
  await expect(confirm.getByText("2 packages in total")).toBeVisible();
  await confirm.getByRole("button", { name: "Install" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Installing…" })).toBeVisible();
  const save = state.requests.find((r) => r.path === "servers").body;
  expect(save).toMatchObject({
    confirmInstall: true,
    previewId: "p1",
    source: { name: "server-x", version: "1.1.0" },
  });
  expect(save.confirmStdio).toBeUndefined();
});

test("allowing scripts shows the warning before the preview", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("region", { name: "MCP servers" })
    .getByRole("button", { name: "Add MCP server" })
    .click();
  const dialog = accountDetail(page);
  await dialog.getByRole("radio", { name: "Local command (stdio)" }).check();
  await dialog.getByRole("radio", { name: "Install package" }).check();
  await dialog.getByLabel("Allow install scripts or source builds").check();
  await expect(
    dialog.getByText(/runs during installation with your user's rights/),
  ).toBeVisible();
});
```

Run: `npm run build && npx playwright test tests/browser/mcp-packages.spec.js --project=desktop && AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/mcp-packages.spec.js --project=desktop`
Expected: PASS in Chromium and WebKit (`playwright.config.js` picks the engine from `AGENTPIER_TEST_BROWSER`; its `tablet` project only matches `assistant*.spec.js`). Also exercise German once: add a third test that sets `agentpier-language` to `de`, opens the form the same way (stdio radio `Lokaler Befehl (stdio)` as `web/lib/i18n/de/mcp-servers.js` names it) and asserts `getByRole("radio", { name: "Paket installieren" })` is visible.

- [ ] **Step 6: Run unit suites and commit**

Run: `node --test tests/unit/i18n-catalogs.test.js tests/unit/mcp-server-draft.test.js tests/unit/mcp-server-save.test.js && npm run lint`
Expected: PASS.

```bash
git add web tests/unit/mcp-server-draft.test.js tests/unit/mcp-server-save.test.js tests/browser/mcp-packages.spec.js
git commit -m "feat: install npm MCP server packages from the server form

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Documentation

**Files:**

- Modify: `docs/mcp.md` (new subsection under "Central MCP servers in the coding CLIs", line 156)
- Modify: `docs/AGENTS.md` ("MCP servers" bullet in "Capabilities")
- Modify: `docs/sandbox.md` ("The grant model", line 62)
- Modify: `docs/installation.md` ("Toolchains for MCP server packages", line 351) and `docs/linux.md` ("Toolchains für MCP-Pakete", line 160; a small edit to a German document stays German)
- Check: `grep -rn "servers.sqlite\|mcp-servers/" docs/` and update any list of MCP server backup contents (e.g. `docs/assistant-gateway.md` "Backups") to say package sources and locks are backed up, installs are not.

- [ ] **Step 1: Write the docs**

`docs/mcp.md`:

```markdown
### Installing a server package

A local (stdio) server can come from a package instead of an own command: choose
**Install package**, a registry (npm), the package and a version. An existing local
server with an own command can switch to **Install package** the same way; its
arguments and environment stay, and it keeps running its own command until the
install is ready. The version list is
read from the registry, newest first; prereleases are hidden unless **Show
prereleases** is on, and deprecated versions are marked. Saving first resolves the
complete dependency graph without running package code and shows the package, its
integrity, the number of packages and its programs; nothing is installed before you
confirm. That confirmation replaces the usual local-command confirmation.

AgentPier installs the frozen graph with its own Node toolchain into
`mcp-packages/installs/` in the data directory, without install scripts unless you
allowed **install scripts or source builds** for this package (package code then runs
with your user's rights during installation). Only `registry.npmjs.org` is accepted
anywhere in the graph. The server is given to agents and coding CLIs once the install
is ready; until then the CLIs show "its package is not installed yet or is missing".

**Update** resolves a new version, shows which packages were added, removed or changed
and switches only after the new install succeeded; a failed update keeps the old one.
**Reinstall** installs exactly the stored graph again, for example after restoring a
backup on another computer: backups contain the package source and its lock, not the
installed files. Removing the server deletes its installs. Toolchain versions that no
packaged server uses any more are removed from `toolchains/` in the data directory.
```

`docs/AGENTS.md`, extend the **MCP servers** bullet: "A local server can also be installed from an npm package under **Accounts → MCP servers** ([MCP](mcp.md#installing-a-server-package))."

`docs/installation.md`, end of the second paragraph of "Toolchains for MCP server packages": "Once no packaged MCP server and no running install uses an older toolchain version, AgentPier removes its folder (at start, after each install and after a server is removed); the current pins always stay."

`docs/linux.md`, after the first sentence of "Toolchains für MCP-Pakete": "Ältere Toolchain-Versionen, die kein MCP-Paket mehr nutzt, entfernt AgentPier selbst."

`docs/sandbox.md`, in the grant model: "A packaged MCP server is the exception to "nothing inside the data directory": its install under `mcp-packages/installs/<id>` and the toolchain it runs with under `toolchains/` are granted read-only; nothing else in the data directory is opened."

- [ ] **Step 2: Format, lint and commit**

Run: `npm run format && npm run lint`

```bash
git add docs
git commit -m "docs: describe installing MCP server packages from npm

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Full check and plan cleanup

- [ ] **Step 1: Run everything**

Run: `npm run check && npm run build && npx playwright test tests/browser/mcp-packages.spec.js tests/browser/agent-mcp-servers.spec.js tests/browser/mcp-cli-bindings.spec.js`
Expected: PASS (note the known Unicode login-shell test if it fails locally).

- [ ] **Step 2: Manual smoke test in English**

Run: `npm run build && AGENTPIER_DATA_DIR=$(mktemp -d) npm start`, open `http://127.0.0.1:4380/accounts`, add a server from `@modelcontextprotocol/server-memory` at its latest version, confirm, wait for "Installed", bind it to Claude Code and check `~/.claude.json` is **not** touched in a disposable profile (use the existing disposable-profile approach from `docs/mcp.md` "Verification limits"; never your real profile).

- [ ] **Step 3: Delete this plan and commit**

```bash
git rm docs/superpowers/plans/2026-10-14-mcp-packages-2-npm.md
git commit -m "chore: remove the completed npm package plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The spec `docs/superpowers/specs/2026-10-14-mcp-package-install-design.md` stays: plan 3 (PyPI) still needs it. The PR lists `docs/mcp.md`, `docs/AGENTS.md`, `docs/sandbox.md`, `docs/installation.md`, `docs/linux.md` and any backup doc touched, plus screenshots of the form (including the switch of an own-command server), the confirmation and the status panel.
