# MCP Server Wizard – PR 4: Directory UI, Origin and Update Pill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner search the MCP Registry inside the wizard, open an entry's detail, start the setup from it ("Use this server", never installing by itself), remember which directory entry a server came from, and show "Update available" in the MCP list and the package panel when the directory lists a newer version of the same package.

**Architecture:** The wizard gains a `via: "directory"` entry (Source → Directory → set-up → Settings → …) with `DirectoryStep` (search, filter chips, results, paging) and `DirectoryDetail` (sheet on phones, side panel on desktop). A pure `directory-draft.js` maps a PR 3 `Entry`/`Option` to a wizard draft. The server stores `directoryOrigin { name, version }` in a new non-secret `directory_origin` column (backed up, validated on restore) and answers `GET /api/mcp-directory/updates` for the list pill by comparing each origin's latest directory version with the installed package.

**Tech Stack:** Node.js 22.13+ ES modules, Express, `node:sqlite`, React 18 JSX, `node:test`, fast-check, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-16-mcp-wizard-design.md` – "Set up – directory search (stage 2)", the directory states of "Source", "Set up – package" (directory hint), "Set up – server on the internet" (URL templates), "Edit flow" (required markers from the directory, update pill), "Update pill (stage 2)", decisions Q4, Q5, Q8, Q9, rollout stage 2b.

**Depends on:** PR 1, PR 2 and PR 3 merged to `main` (uses PR 2's `via` handling in `wizard-state.js` and PR 3's `/api/mcp-directory/*`, `Entry` DTO and `mcpDirectoryCopy` catalog). Branch `feat/mcp-directory-ui` from `origin/main`. This is the last PR: it deletes the spec and this plan.

## Global Constraints

- Platform: macOS or Linux, Node.js 22.13+. ES modules, React JSX.
- Prettier: two-space indentation, double quotes, semicolons, trailing commas, 90 columns; `npm run format`, `npm run lint`.
- Files ≤ 600 lines (`npm run check:structure`).
- UI copy in `web/lib/i18n/en/mcp-directory.js` and `web/lib/i18n/de/mcp-directory.js` (same keys and arguments), imported from `web/lib/i18n/messages/mcp-directory.js`; no hardcoded copy; directory text (names, titles, descriptions) stays in its original language; dates via `Intl` in the UI locale (`toLocaleDateString(locale)`).
- Trust copy (Q4): no "reviewed by AgentPier" anywhere. The only sentences: "A directory listing is not a security review." and, where a package is shown, "Check who published the package before you install it." "Verified" only explains namespace and package ownership.
- Q5: unsupported registry types greyed under **All**, hidden by the default filter **Installable here**.
- Never auto-install: **Use this server** only fills the draft; installing still needs the package preview and **Install**; binding still needs Connect. Directory data is never written to CLI or agent configs.
- Nothing is fetched without an owner action: opening the directory, searching, opening a detail, or opening the MCP list (update pill).
- `directoryOrigin` (Q9): `{ name, version }`, non-secret, validated like the DTO (name `^[A-Za-z0-9.-]{1,150}/[A-Za-z0-9._-]{1,150}$`, version printable ASCII ≤ 128), stored in `servers.directory_origin`, included in backups, invalid values dropped on restore.
- Update pill (Q8): only for servers created from the directory; ≤ 20 servers checked, ≤ 4 in parallel, server-side cache 1 h (PR 3); a newer exact version of the **same** identifier shows the pill; an identifier change or a remote URL change is a hint only, never applied.
- Links: http(s) only, `rel="noopener noreferrer"`, shown as host + path text.
- Accessibility: filter chips are buttons with `aria-pressed`; search status in one `role="status"` region; skeletons `aria-hidden`; detail sheet uses `Sheet`/`SidePanel`; "How it runs" is a radio list in a `fieldset`/`legend`; targets ≥ 44 px; no horizontal scroll at 390 px.
- Tests: `node:test` strict, fast-check, isolated SQLite stores in temp dirs, crafted-backup tests in the style of `tests/integration/mcp-server-backup-crafted.test.js`, Playwright desktop + phone describe block; desktop-only behaviour `test.skip(isMobile, …)`; `page.route` fixtures only.
- No change to `cli-reconciler.js`, `cli-bindings.js`, `program-select.js`, `mcp-packages.js`, `package-install-job.js`; `mcp-server-draft.js` stays unchanged (the origin travels through `mcpServerStep`).
- Docs in the same PR (`docs/mcp.md`, `docs/assistant-gateway.md` "Backups" if it lists store columns, README feature line if it names MCP setup). PR description lists docs checked; screenshots via `agent-pier-assets`; release notes later mention the directory's preview status and that searches go to the configured registry host.
- Commits in English (`feat:`/`fix:`/`chore:`/`docs:`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; linear history.
- Final cleanup in this PR: delete `docs/superpowers/specs/2026-10-16-mcp-wizard-design.md` and this plan; confirm plans 1–3 are already gone (`ls docs/superpowers/plans/ | grep mcp-wizard` prints only this plan before its deletion).

## Review Focus

1. **A server created from the directory is renamed, then its package is updated through the panel.** The origin must survive both (rename and update do not touch `directory_origin`) and the pill must disappear once the installed version equals the listed one. Pinned in Task 1 (store) and Task 2 (comparison).
2. **The directory lists a newer version whose npm identifier changed** (`old-pkg` → `@scope/new-pkg`). No pill, only a hint, and Check update is not pre-filled with a version of another package. Pinned in Task 2.
3. **A remote entry with `https://{tenant}.example.test/mcp`**: the owner types `acme corp` → the address is composed with the value URL-encoded (`acme%20corp`), never with the raw `{tenant}` left in. Pinned in Task 3.
4. **The directory is turned off while the wizard is on the Directory step.** The next search answers `409`; the step must show "Directory turned off" with a link to Settings, not a generic error. Pinned in Task 5.
5. **A crafted backup with `directory_origin = '{"name":"x","version":"1"}'`** (invalid name) or a non-JSON value. Restore must drop it to `NULL`; the server keeps working and shows no pill. Pinned in Task 1.

## File Structure

Create:

| File                                                                                                                           | Responsibility                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `server/features/mcp-servers/directory-origin.js`                                                                              | `cleanDirectoryOrigin(value)`, `readDirectoryOrigin(text)`.                                 |
| `server/features/mcp-directory/updates.js`                                                                                     | `directoryUpdate(server, entry)`, `directoryUpdates({ servers, detail, limit, parallel })`. |
| `web/features/mcp-servers/wizard/directory-api.js`                                                                             | Browser calls to `/api/mcp-directory/*`.                                                    |
| `web/features/mcp-servers/wizard/directory-draft.js`                                                                           | `draftFromEntry(entry, option, { taken })`, `composeUrl(template)`, `optionLabel` helpers.  |
| `web/features/mcp-servers/wizard/useDirectoryStatus.js`, `useDirectoryUpdates.js`                                              | Status for the Source card; updates for the list and panel.                                 |
| `web/features/mcp-servers/wizard/DirectoryStep.jsx`, `DirectoryResult.jsx`, `DirectoryDetail.jsx`                              | Search screen, result card, detail sheet.                                                   |
| `tests/unit/mcp-directory-origin.test.js`, `mcp-directory-updates.test.js`, `mcp-directory-draft.test.js`                      | Unit tests.                                                                                 |
| `tests/integration/mcp-directory-origin-backup.test.js`, `mcp-directory-updates-route.test.js`                                 | Store/backup and route tests.                                                               |
| `tests/browser/mcp-directory-fixture.js`, `tests/browser/mcp-directory.spec.js`, `tests/browser/mcp-directory-updates.spec.js` | Browser coverage.                                                                           |

Modify: `server/features/mcp-servers/mcp-server-store.js` (column, create, public field), `server/features/operations/mcp-server-backup.js` (`knownColumns`, restore cleanup), `server/http/routes/mcp-directory.js` (`/updates`), `web/features/mcp-servers/mcp-server-save.js` (`directoryOrigin`), `web/features/mcp-servers/wizard/wizard-save.js`, `wizard-state.js` (`via: "directory"`, `fromDirectory`), `SourceStep.jsx`, `PackageStep.jsx`, `RemoteStep.jsx`, `McpWizard.jsx`, `EditSettingsStep.jsx`, `web/features/mcp-servers/McpSecretRows.jsx` (`requiredNames`), `web/features/mcp-servers/McpPackagePanel.jsx` (`listedVersion`), `web/features/mcp-servers/wizard/McpServerOverview.jsx`, `web/features/accounts/McpServersGroup.jsx`, `web/lib/i18n/{en,de}/mcp-directory.js`, `tests/integration/mcp-server-backup-hashes.test.js` (known columns), `tests/unit/mcp-server-store.test.js`, `docs/mcp.md`.

## Parallel Groups

- **Group A (parallel):** Task 1 (store + backup), Task 3 (draft mapper + wizard state), Task 4 (copy).
- **Task 2** after 1 (updates logic + route).
- **Task 5** after 3 and 4 (directory screens).
- **Task 6** after 5 (set-up hints, URL templates, origin in the save).
- **Task 7** after 2 and 6 (update pill, panel hint, edit required markers).
- **Task 8** last (docs, spec and plan deletion).

---

### Task 1: `directory_origin` on server records

**Files:**

- Create: `server/features/mcp-servers/directory-origin.js`, `tests/unit/mcp-directory-origin.test.js`, `tests/integration/mcp-directory-origin-backup.test.js`
- Modify: `server/features/mcp-servers/mcp-server-store.js`, `server/features/operations/mcp-server-backup.js`, `tests/unit/mcp-server-store.test.js`, `tests/integration/mcp-server-backup-hashes.test.js`

**Interfaces:**

- Produces: `cleanDirectoryOrigin(value) → { name, version } | null` (throws the store's `invalid()` 400 for a present but invalid value); `readDirectoryOrigin(text) → { name, version } | null` (never throws). `store.create(input)` accepts `input.directoryOrigin`; `publicServer` adds `directoryOrigin` when set. Updates never change it. `restoreMcpServers` sets invalid `directory_origin` values to `NULL`.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/mcp-directory-origin.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  cleanDirectoryOrigin,
  readDirectoryOrigin,
} from "../../server/features/mcp-servers/directory-origin.js";

test("a directory origin is a registry name and an exact version string", () => {
  assert.deepEqual(cleanDirectoryOrigin({ name: "io.github.a/b", version: "0.4.1" }), {
    name: "io.github.a/b",
    version: "0.4.1",
  });
  assert.equal(cleanDirectoryOrigin(undefined), null);
  assert.equal(cleanDirectoryOrigin(null), null);
  for (const bad of [
    { name: "x", version: "1" },
    { name: "a/b", version: "1 2" },
    { name: "a/b", version: "1", extra: true },
    { name: "a/b" },
    "a/b@1",
    [],
  ])
    assert.throws(
      () => cleanDirectoryOrigin(bad),
      (error) => error.status === 400,
      JSON.stringify(bad),
    );
});

test("stored text is read back or ignored, never thrown", () => {
  assert.deepEqual(readDirectoryOrigin('{"name":"a.b/c","version":"1.0.0"}'), {
    name: "a.b/c",
    version: "1.0.0",
  });
  for (const text of [null, "", "{", '{"name":"<x>","version":"1"}', "[]", "42"])
    assert.equal(readDirectoryOrigin(text), null, String(text));
  fc.assert(
    fc.property(fc.string(), (text) =>
      assert.doesNotThrow(() => readDirectoryOrigin(text)),
    ),
  );
});
```

Append to `tests/unit/mcp-server-store.test.js` (it already creates stores in temporary directories; reuse its helper for a store, here called `store(t)`):

```js
test("a directory origin is stored with the server and survives rename and updates", (t) => {
  const servers = store(t);
  const created = servers.create({
    name: "docs",
    transport: "http",
    url: "https://mcp.example.test/mcp",
    directoryOrigin: { name: "ai.smithery/docs", version: "1.2.0" },
  });
  assert.deepEqual(created.directoryOrigin, {
    name: "ai.smithery/docs",
    version: "1.2.0",
  });
  const renamed = servers.update(created.id, {
    revision: created.revision,
    name: "docs2",
  });
  assert.deepEqual(renamed.directoryOrigin, {
    name: "ai.smithery/docs",
    version: "1.2.0",
  });
  assert.equal(servers.list()[0].directoryOrigin.name, "ai.smithery/docs");
  const plain = servers.create({
    name: "plain",
    transport: "http",
    url: "https://p.example.test/mcp",
  });
  assert.equal(plain.directoryOrigin, undefined);
  assert.throws(
    () =>
      servers.create({
        name: "bad",
        transport: "http",
        url: "https://b.example.test/mcp",
        directoryOrigin: { name: "x", version: "1" },
      }),
    (error) => error.status === 400,
  );
});

test("an existing store gains the directory_origin column", (t) => {
  // Opening twice runs the migration on a database created without the column.
  const servers = store(t);
  const columns = servers.db
    .prepare("PRAGMA table_info(servers)")
    .all()
    .map((c) => c.name);
  assert.ok(columns.includes("directory_origin"));
});
```

`server.update` in this store takes `(id, patch, options)` and returns the public server (check the signature at `grep -n "^  update(" server/features/mcp-servers/mcp-server-store.js`; adapt the call if it returns a wrapper).

- [ ] **Step 2: Write the failing backup test**

`tests/integration/mcp-directory-origin-backup.test.js` (modelled on `mcp-server-backup-crafted.test.js`):

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { loadArchive, encodeArchiveV2 } from "../helpers/backup-archive.js";
import { fileMember } from "../../server/features/operations/snapshot.js";

async function backup(t, origin) {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-origin-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const dataDir = path.join(folder, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const servers = new McpServerStore({ dataDir, pathEnv: "/fake/bin" });
  const created = servers.create({
    name: "docs",
    transport: "http",
    url: "https://mcp.example.test/mcp",
    directoryOrigin: origin,
  });
  servers.close();
  const { file } = await new Backup({ dataDir }).create({
    includeHistory: false,
    withCredentials: false,
  });
  return { folder, file, created };
}

const storeMember = "mcp-servers/servers.sqlite";

test("the directory origin is part of the public backup and comes back", async (t) => {
  const { folder, file, created } = await backup(t, {
    name: "ai.smithery/docs",
    version: "1.2.0",
  });
  const target = path.join(folder, "restored");
  await new Restore({ dataDir: target }).fromFile(file);
  const servers = new McpServerStore({ dataDir: target, pathEnv: "/fake/bin" });
  t.after(() => servers.close());
  assert.deepEqual(servers.get(created.id).directoryOrigin, {
    name: "ai.smithery/docs",
    version: "1.2.0",
  });
});

test("a crafted origin is dropped on restore", async (t) => {
  const { folder, file, created } = await backup(t, {
    name: "ai.smithery/docs",
    version: "1.2.0",
  });
  const archive = loadArchive(file);
  for (const value of ['{"name":"x","version":"1"}', "not json"]) {
    const files = archive.files.map((member) => {
      if (member.path !== storeMember) return member;
      const scratch = path.join(
        folder,
        `crafted-${Math.random().toString(36).slice(2)}.sqlite`,
      );
      fs.writeFileSync(scratch, Buffer.from(member.content, "base64"));
      const db = new DatabaseSync(scratch);
      db.prepare("UPDATE servers SET directory_origin=?").run(value);
      db.close();
      return fileMember(storeMember, fs.readFileSync(scratch));
    });
    const crafted = path.join(folder, "crafted.agentpier-backup");
    fs.writeFileSync(crafted, await encodeArchiveV2({ ...archive, files }));
    const target = path.join(folder, `restored-${value.length}`);
    await new Restore({ dataDir: target }).fromFile(crafted);
    const servers = new McpServerStore({ dataDir: target, pathEnv: "/fake/bin" });
    assert.equal(servers.get(created.id).directoryOrigin, undefined, value);
    const raw = servers.db.prepare("SELECT directory_origin FROM servers").get();
    assert.equal(raw.directory_origin, null, value);
    servers.close();
  }
});
```

The helper names (`Backup.create` options, `Restore#fromFile`, `loadArchive(file).files[].content`, `encodeArchiveV2`) follow `mcp-server-backup-crafted.test.js`; read that file first and use its exact calls (it restores through the same helpers; copy its restore invocation rather than guessing).

Run: `node --test tests/unit/mcp-directory-origin.test.js tests/unit/mcp-server-store.test.js tests/integration/mcp-directory-origin-backup.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`server/features/mcp-servers/directory-origin.js`:

```js
import { invalid } from "./mcp-server-fields.js";

// Which MCP Registry entry a server was set up from (decision Q9). Not secret; it
// only decides the "Update available" hint.
const namePattern = /^[A-Za-z0-9.-]{1,150}\/[A-Za-z0-9._-]{1,150}$/;
const versionPattern = /^[\x21-\x7e]{1,128}$/;

const valid = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => key === "name" || key === "version") &&
  typeof value.name === "string" &&
  namePattern.test(value.name) &&
  typeof value.version === "string" &&
  versionPattern.test(value.version);

/** The origin a create request carries, or null; a present invalid one is a 400. */
export function cleanDirectoryOrigin(value) {
  if (value === undefined || value === null) return null;
  if (!valid(value)) throw invalid();
  return { name: value.name, version: value.version };
}

/** The stored column, or null for anything that does not validate. */
export function readDirectoryOrigin(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    const value = JSON.parse(text);
    return valid(value) ? { name: value.name, version: value.version } : null;
  } catch {
    return null;
  }
}
```

`mcp-server-store.js`:

- After the `oauth_login_redirect` migration add:

```js
if (!columns.some((c) => c.name === "directory_origin"))
  this.db.exec("ALTER TABLE servers ADD COLUMN directory_origin TEXT");
```

and add `directory_origin TEXT` to the `CREATE TABLE servers` statement in `schema`.

- In `publicServer(row, packages)` add, after `revision: row.revision,`:

```js
      ...(readDirectoryOrigin(row.directory_origin)
        ? { directoryOrigin: readDirectoryOrigin(row.directory_origin) }
        : {}),
```

- In `create(input, …)`: compute `const origin = cleanDirectoryOrigin(record(input) ? input.directoryOrigin : undefined);` before the transaction, and inside it, after `insertOrUpdate`:

```js
if (origin)
  this.db
    .prepare("UPDATE servers SET directory_origin=? WHERE id=?")
    .run(JSON.stringify(origin), id);
```

`update()` builds its row fields from `definition()`, which never reads `directoryOrigin`, so updates keep the column untouched. Import `cleanDirectoryOrigin`, `readDirectoryOrigin` from `./directory-origin.js`.

`mcp-server-backup.js`:

- Add `"directory_origin"` to `knownColumns.servers`.
- In `restoreMcpServers`, inside the transaction after `applySealed`, drop invalid origins:

```js
const columns = new Set(
  db
    .prepare("PRAGMA table_info(servers)")
    .all()
    .map((column) => column.name),
);
if (columns.has("directory_origin")) {
  const clear = db.prepare("UPDATE servers SET directory_origin=NULL WHERE id=?");
  for (const row of db
    .prepare(
      "SELECT id, directory_origin FROM servers WHERE directory_origin IS NOT NULL",
    )
    .all())
    if (!readDirectoryOrigin(row.directory_origin)) clear.run(row.id);
}
```

(import `readDirectoryOrigin` from `../mcp-servers/directory-origin.js`).

`tests/integration/mcp-server-backup-hashes.test.js`: if it asserts the list of public columns, add `directory_origin`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/unit/mcp-directory-origin.test.js tests/unit/mcp-server-store.test.js tests/integration/mcp-directory-origin-backup.test.js tests/integration/mcp-server-backup-crafted.test.js tests/integration/mcp-server-backup-hashes.test.js tests/integration/mcp-backup.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-servers server/features/operations/mcp-server-backup.js tests/unit/mcp-directory-origin.test.js tests/unit/mcp-server-store.test.js tests/integration/mcp-directory-origin-backup.test.js tests/integration/mcp-server-backup-hashes.test.js
git commit -m "feat: remember which directory entry an MCP server came from

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Directory updates for the list

**Files:**

- Create: `server/features/mcp-directory/updates.js`, `tests/unit/mcp-directory-updates.test.js`, `tests/integration/mcp-directory-updates-route.test.js`
- Modify: `server/http/routes/mcp-directory.js`

**Interfaces:**

- Consumes: `compareSemver` (`registry-metadata.js`), `comparePep440` (`pep440.js`), `McpDirectory#detail(name)` (PR 3), `services.mcpServers.list()`.
- Produces:
  - `directoryUpdate(server, entry) → { serverId, version } | { serverId, hint: "identifier"|"remote" } | null`.
  - `directoryUpdates({ servers, detail, limit = 20, parallel = 4 }) → Promise<Update[]>` (failures per server are skipped).
  - `GET /api/mcp-directory/updates` → `{ updates: Update[] }`; while the directory is off: `{ updates: [] }` without any request.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mcp-directory-updates.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  directoryUpdate,
  directoryUpdates,
} from "../../server/features/mcp-directory/updates.js";

const packaged = (extra = {}) => ({
  id: "s1",
  transport: "stdio",
  source: { registry: "npm", name: "opnsense-mcp-server", version: "0.4.1" },
  directoryOrigin: { name: "io.github.example/opnsense-mcp-server", version: "0.4.1" },
  ...extra,
});
const entry = (options) => ({
  name: "io.github.example/opnsense-mcp-server",
  version: "0.5.0",
  options,
});
const npm = (identifier, version) => ({ kind: "npm", identifier, version });

test("a newer exact version of the same package is an update", () => {
  assert.deepEqual(
    directoryUpdate(packaged(), entry([npm("opnsense-mcp-server", "0.5.0")])),
    {
      serverId: "s1",
      version: "0.5.0",
    },
  );
  assert.equal(
    directoryUpdate(packaged(), entry([npm("opnsense-mcp-server", "0.4.1")])),
    null,
  );
  assert.equal(
    directoryUpdate(packaged(), entry([npm("opnsense-mcp-server", "0.4.0")])),
    null,
  );
  const pypi = packaged({
    source: { registry: "pypi", name: "mcp-server-fetch", version: "2025.4.7" },
  });
  assert.deepEqual(
    directoryUpdate(
      pypi,
      entry([{ kind: "pypi", identifier: "mcp_server_fetch", version: "2025.10.1" }]),
    ),
    { serverId: "s1", version: "2025.10.1" },
  );
});

test("a changed identifier or remote address is a hint only", () => {
  assert.deepEqual(
    directoryUpdate(packaged(), entry([npm("@example/opnsense", "1.0.0")])),
    {
      serverId: "s1",
      hint: "identifier",
    },
  );
  const remote = {
    id: "r1",
    transport: "http",
    url: "https://old.example.test/mcp",
    directoryOrigin: { name: "a.b/c", version: "1" },
  };
  assert.deepEqual(
    directoryUpdate(
      remote,
      entry([{ kind: "remote-http", url: "https://new.example.test/mcp" }]),
    ),
    { serverId: "r1", hint: "remote" },
  );
  assert.equal(
    directoryUpdate(
      remote,
      entry([{ kind: "remote-http", url: "https://old.example.test/mcp" }]),
    ),
    null,
  );
  assert.equal(
    directoryUpdate({ ...packaged(), directoryOrigin: undefined }, entry([])),
    null,
  );
});

test("at most 20 servers, 4 at a time; failures are skipped", async () => {
  let running = 0;
  let peak = 0;
  const servers = Array.from({ length: 25 }, (_, index) =>
    packaged({
      id: `s${index}`,
      directoryOrigin: { name: `a.b/s${index}`, version: "0.4.1" },
    }),
  );
  const asked = [];
  const updates = await directoryUpdates({
    servers,
    detail: async (name) => {
      asked.push(name);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (name === "a.b/s3") throw new Error("down");
      return entry([npm("opnsense-mcp-server", "0.5.0")]);
    },
  });
  assert.equal(asked.length, 20);
  assert.ok(peak <= 4);
  assert.equal(updates.length, 19);
});
```

`tests/integration/mcp-directory-updates-route.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mcpDirectoryRoutes } from "../../server/http/routes/mcp-directory.js";
import { registerResponses } from "../../server/http/responses.js";

async function app(t, { enabled = true, servers = [], detail }) {
  const calls = [];
  const services = {
    mcpServers: { list: () => servers },
    mcpDirectory: {
      current: () => ({ enabled }),
      detail: async (name) => {
        calls.push(name);
        return detail(name);
      },
    },
  };
  const application = express();
  application.use("/api", mcpDirectoryRoutes(services));
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const listening = application.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  const get = async () =>
    (
      await fetch(`http://127.0.0.1:${server.address().port}/api/mcp-directory/updates`)
    ).json();
  return { get, calls };
}

const origin = { name: "a.b/c", version: "1.0.0" };

test("updates are asked only for servers from the directory", async (t) => {
  const { get, calls } = await app(t, {
    servers: [
      {
        id: "s1",
        transport: "stdio",
        source: { registry: "npm", name: "c", version: "1.0.0" },
        directoryOrigin: origin,
      },
      { id: "s2", transport: "http", url: "https://x.test/mcp" },
    ],
    detail: async () => ({
      options: [{ kind: "npm", identifier: "c", version: "1.1.0" }],
    }),
  });
  assert.deepEqual(await get(), { updates: [{ serverId: "s1", version: "1.1.0" }] });
  assert.deepEqual(calls, ["a.b/c"]);
});

test("a turned-off directory answers no updates and asks nothing", async (t) => {
  const { get, calls } = await app(t, {
    enabled: false,
    servers: [{ id: "s1", directoryOrigin: origin }],
    detail: async () => ({ options: [] }),
  });
  assert.deepEqual(await get(), { updates: [] });
  assert.deepEqual(calls, []);
});
```

Run: `node --test tests/unit/mcp-directory-updates.test.js tests/integration/mcp-directory-updates-route.test.js`
Expected: FAIL.

- [ ] **Step 2: Implement**

`server/features/mcp-directory/updates.js`:

```js
import { normalizePypiName } from "../mcp-packages/package-spec.js";
import { comparePep440 } from "../mcp-packages/pep440.js";
import { compareSemver } from "../mcp-packages/registry-metadata.js";

// "Update available" for servers set up from the directory (decisions Q8, Q9): only a
// newer exact version of the same package. A changed identifier or address is a hint.
const sameName = (registry, a, b) =>
  registry === "pypi" ? normalizePypiName(a) === normalizePypiName(b) : a === b;
const newer = (registry, candidate, installed) => {
  try {
    return (
      (registry === "pypi" ? comparePep440 : compareSemver)(candidate, installed) > 0
    );
  } catch {
    return false;
  }
};

export function directoryUpdate(server, entry) {
  if (!server?.directoryOrigin || !Array.isArray(entry?.options)) return null;
  const { source } = server;
  if (source) {
    const options = entry.options.filter((option) => option.kind === source.registry);
    const same = options.find((option) =>
      sameName(source.registry, option.identifier, source.name),
    );
    if (same)
      return newer(source.registry, same.version, source.version)
        ? { serverId: server.id, version: same.version }
        : null;
    return options.length ? { serverId: server.id, hint: "identifier" } : null;
  }
  if (server.transport !== "stdio" && server.url) {
    // A template address ({var}) never equals a stored one; it is not compared.
    const remotes = entry.options.filter(
      (option) => option.kind?.startsWith("remote-") && !option.urlVariables?.length,
    );
    if (remotes.length && !remotes.some((option) => option.url === server.url))
      return { serverId: server.id, hint: "remote" };
  }
  return null;
}

/** Asks the directory for at most `limit` servers, `parallel` at a time. */
export async function directoryUpdates({ servers, detail, limit = 20, parallel = 4 }) {
  const queue = servers.filter((server) => server.directoryOrigin).slice(0, limit);
  const updates = [];
  const worker = async () => {
    for (let server = queue.shift(); server; server = queue.shift()) {
      try {
        const update = directoryUpdate(server, await detail(server.directoryOrigin.name));
        if (update) updates.push(update);
      } catch {
        // One unreachable entry hides only its own pill.
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return updates.sort((a, b) => a.serverId.localeCompare(b.serverId));
}
```

`server.url` is the public URL (origin and path, no query), which is what a directory remote URL holds.

Check `comparePep440` signature in `server/features/mcp-packages/pep440.js` (`(a, b) → number`) and `compareSemver` in `registry-metadata.js` (`(a, b) → number`); both are already used for sorting.

In `server/http/routes/mcp-directory.js` add before `/mcp-directory/servers/:name`:

```js
router.get("/mcp-directory/updates", async (_req, res) => {
  const directory = services.mcpDirectory;
  if (!directory || !services.mcpServers || !directory.current().enabled)
    return res.json({ updates: [] });
  res.json({
    updates: await directoryUpdates({
      servers: services.mcpServers.list(),
      detail: (name) => directory.detail(name),
    }),
  });
});
```

(`current()` is the `McpDirectory` method from PR 3 that returns `{ enabled, baseUrl, host }`.)

- [ ] **Step 3: Run to verify it passes**

Run: `node --test tests/unit/mcp-directory-updates.test.js tests/integration/mcp-directory-updates-route.test.js tests/integration/mcp-directory-routes.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/features/mcp-directory/updates.js server/http/routes/mcp-directory.js tests/unit/mcp-directory-updates.test.js tests/integration/mcp-directory-updates-route.test.js
git commit -m "feat: find newer directory versions of MCP servers set up from it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Directory entry → wizard draft

**Files:**

- Create: `web/features/mcp-servers/wizard/directory-draft.js`, `tests/unit/mcp-directory-draft.test.js`
- Modify: `web/features/mcp-servers/wizard/wizard-state.js`, `tests/unit/mcp-wizard-state.test.js`

**Interfaces:**

- Consumes: PR 3 `Entry`/`Option`; PR 1 `sanitiseName`, `uniqueName`.
- Produces:
  - `draftFromEntry(entry, option, { taken }) → Draft` with `path` (`"package"|"remote"`), `name`, `origin: "directory"`, `directoryOrigin: { name, version }`, `hints: { settings, directory: { name, title, version } }`, package fields (`registry`, `packageName`, `packageVersion`, `argRows`, `env`) or remote fields (`transport`, `url`, `urlTemplate: { url, variables, values } | null`, `signIn`, `headers`).
  - `composeUrl(template) → string` – every `{var}` replaced by the URL-encoded value.
  - `composeValue({ value, values }) → string` – same, unencoded. Env and header rows whose value wraps a `{var}` in other text (`Token {key}`, `postgres://{user}:{pw}@db/x`) carry `template: { value, variables, values }` and their settings hint carries `template`; Tasks 6/7 render one field per variable and save `composeValue(...)` as the literal. Only the first `Bearer {var}` header has `key: "auth"`.
  - `isSelectable(option) → boolean` (`kind !== "unsupported"`).
  - Wizard state: `stepOrder(path, "directory")` → `["source", "directory", …]`; action `fromDirectory { draft }` (like PR 2's `pasted`, visiting `directory`, the set-up step and `settings`).

- [ ] **Step 1: Write the failing tests**

`tests/unit/mcp-directory-draft.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  composeUrl,
  draftFromEntry,
} from "../../web/features/mcp-servers/wizard/directory-draft.js";

const input = (name, extra = {}) => ({
  name,
  description: "",
  required: false,
  secret: false,
  format: "string",
  default: null,
  choices: [],
  value: null,
  variables: [],
  ...extra,
});
const entry = (options) => ({
  name: "io.github.example/opnsense-mcp-server",
  title: "OPNsense",
  version: "0.4.1",
  options,
});

test("an npm option becomes a package draft with its settings as hints", () => {
  const draft = draftFromEntry(
    entry([]),
    {
      kind: "npm",
      identifier: "opnsense-mcp-server",
      version: "0.4.1",
      packageArgs: ["--log-level", "info"],
      env: [
        input("OPNSENSE_API_KEY", {
          description: "API key",
          required: true,
          secret: true,
        }),
        input("OPNSENSE_VERIFY_SSL", { format: "boolean", default: "true" }),
        input("MODE", { choices: ["read", "write"] }),
      ],
    },
    { taken: ["opnsense-mcp-server"] },
  );
  assert.equal(draft.path, "package");
  assert.equal(draft.name, "opnsense-mcp-server-2");
  assert.deepEqual(
    [draft.registry, draft.packageName, draft.packageVersion],
    ["npm", "opnsense-mcp-server", "0.4.1"],
  );
  assert.deepEqual(draft.argRows, ["--log-level", "info"]);
  assert.deepEqual(
    draft.env.map((row) => [row.name, row.value, row.fixed]),
    [
      ["OPNSENSE_API_KEY", "", true],
      ["OPNSENSE_VERIFY_SSL", "", true],
      ["MODE", "", true],
    ],
  );
  assert.deepEqual(draft.hints.settings.OPNSENSE_API_KEY, {
    description: "API key",
    required: true,
    secret: true,
  });
  assert.deepEqual(draft.hints.settings.OPNSENSE_VERIFY_SSL, {
    description: "",
    required: false,
    secret: false,
    format: "boolean",
    default: "true",
  });
  assert.deepEqual(draft.hints.settings.MODE.choices, ["read", "write"]);
  assert.deepEqual(draft.directoryOrigin, {
    name: "io.github.example/opnsense-mcp-server",
    version: "0.4.1",
  });
  assert.equal(draft.origin, "directory");
});

test("a remote option with URL variables and a Bearer header", () => {
  const draft = draftFromEntry(entry([]), {
    kind: "remote-http",
    url: "https://{tenant}.files.example.test/mcp",
    urlVariables: [
      {
        name: "tenant",
        description: "Tenant",
        required: true,
        secret: false,
        default: null,
        choices: [],
      },
    ],
    headers: [
      input("Authorization", { required: true, secret: true, value: "Bearer {token}" }),
    ],
  });
  assert.deepEqual(
    [draft.path, draft.transport, draft.url, draft.signIn],
    ["remote", "http", "", "headers"],
  );
  assert.equal(draft.urlTemplate.url, "https://{tenant}.files.example.test/mcp");
  assert.deepEqual(
    draft.headers.map(({ key, name, value, bearer }) => [key, name, value, bearer]),
    [["auth", "Authorization", "", true]],
  );
  assert.equal(
    composeUrl({ ...draft.urlTemplate, values: { tenant: "acme corp" } }),
    "https://acme%20corp.files.example.test/mcp",
  );
  fc.assert(
    fc.property(fc.string(), (value) => {
      const url = composeUrl({ ...draft.urlTemplate, values: { tenant: value } });
      assert.ok(!url.includes("{tenant}"));
    }),
  );
});
```

Append to `tests/unit/mcp-wizard-state.test.js`:

```js
test("the directory is its own entry: Source → Directory → set-up → Settings", () => {
  const state = run([
    { type: "via", via: "directory" },
    {
      type: "fromDirectory",
      draft: {
        path: "remote",
        name: "docs",
        url: "https://x.test/mcp",
        origin: "directory",
      },
    },
  ]);
  assert.deepEqual(stepOrder(state.path, state.via), [
    "source",
    "directory",
    "remote",
    "settings",
    "review",
    "connect",
    "done",
  ]);
  assert.equal(previousStep(state, "remote"), "directory");
  assert.equal(state.draft.origin, "directory");
});
```

Run: `node --test tests/unit/mcp-directory-draft.test.js tests/unit/mcp-wizard-state.test.js`
Expected: FAIL.

- [ ] **Step 2: Implement**

`web/features/mcp-servers/wizard/directory-draft.js`:

```js
import { sanitiseName, uniqueName } from "./server-name.js";

// A directory entry's chosen way to run → the wizard draft. Values are never taken
// from the directory except fixed literal ones; templates become fields to fill.
const template = /\{[A-Za-z_][A-Za-z0-9_-]{0,63}\}/;
const bearerTemplate = /^Bearer \{[A-Za-z_][A-Za-z0-9_-]{0,63}\}$/;

export const isSelectable = (option) => option?.kind !== "unsupported";

export const composeUrl = ({ url, values = {} }) =>
  url.replace(/\{([A-Za-z_][A-Za-z0-9_-]{0,63})\}/g, (_, name) =>
    encodeURIComponent(values[name] ?? ""),
  );

function hint(item, extra = {}) {
  return {
    description: item.description,
    required: item.required === true || extra.required === true,
    secret: item.secret === true || extra.secret === true,
    ...(item.choices?.length ? { choices: item.choices } : {}),
    ...(item.format === "boolean" ? { format: "boolean" } : {}),
    ...(item.default !== null && item.default !== undefined
      ? { default: item.default }
      : {}),
  };
}

const literal = (value) =>
  typeof value === "string" && !template.test(value) ? value : "";

export function draftFromEntry(entry, option, { taken = [] } = {}) {
  const base =
    sanitiseName(entry.name.split("/").pop()) || sanitiseName(entry.title) || "server";
  const settings = {};
  const common = {
    name: uniqueName(base, taken),
    origin: "directory",
    directoryOrigin: { name: entry.name, version: entry.version },
  };
  if (option.kind === "npm" || option.kind === "pypi") {
    const env = option.env.map((item, index) => {
      settings[item.name] = hint(item);
      return {
        key: `directory-env-${index}`,
        name: item.name,
        value: literal(item.value),
        fixed: true,
      };
    });
    return {
      ...common,
      path: "package",
      transport: "stdio",
      source: "package",
      registry: option.kind,
      packageName: option.identifier,
      packageVersion: option.version,
      argRows: [...option.packageArgs],
      env,
      hints: {
        settings,
        directory: { name: entry.name, title: entry.title, version: entry.version },
      },
    };
  }
  const headers = option.headers.map((item, index) => {
    const bearer = bearerTemplate.test(item.value ?? "");
    settings[item.name] = hint(item, bearer ? { required: true, secret: true } : {});
    return {
      key: bearer ? "auth" : `directory-header-${index}`,
      name: item.name,
      value: literal(item.value),
      fixed: true,
      ...(bearer ? { bearer: true } : {}),
    };
  });
  const variables = option.urlVariables ?? [];
  return {
    ...common,
    path: "remote",
    transport: option.kind === "remote-sse" ? "sse" : "http",
    source: "command",
    url: variables.length ? "" : option.url,
    urlTemplate: variables.length ? { url: option.url, variables, values: {} } : null,
    signIn: headers.length ? "headers" : "none",
    headers,
    hints: {
      settings,
      directory: { name: entry.name, title: entry.title, version: entry.version },
    },
  };
}
```

`wizard-state.js`: generalise PR 2's `stepOrder`:

```js
const entries = ["paste", "directory"];
export const stepOrder = (path, via = null) => {
  const order = orders[path] ?? ["source"];
  if (!entries.includes(via)) return order;
  return path ? ["source", via, ...order.slice(1)] : ["source", via];
};
```

add the case (same body as PR 2's `pasted`, visiting `directory`):

```js
    case "fromDirectory": {
      const { path, ...values } = action.draft;
      return {
        ...state,
        path,
        visited: ["source", "directory", path, "settings"],
        draft: { ...initialWizard().draft, ...pathValues[path], ...values },
        fieldError: null,
      };
    }
```

and add `directoryOrigin: null` and `urlTemplate: null` to the initial draft.

- [ ] **Step 3: Run to verify it passes**

Run: `node --test tests/unit/mcp-directory-draft.test.js tests/unit/mcp-wizard-state.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/features/mcp-servers/wizard/directory-draft.js web/features/mcp-servers/wizard/wizard-state.js tests/unit/mcp-directory-draft.test.js tests/unit/mcp-wizard-state.test.js
git commit -m "feat: turn an MCP directory entry into a wizard draft

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Directory copy

**Files:**

- Modify: `web/lib/i18n/en/mcp-directory.js`, `web/lib/i18n/de/mcp-directory.js`
- Test: `tests/unit/i18n-catalogs.test.js`, `tests/unit/i18n-terminology.test.js`

**Interfaces:**

- Produces the keys below in `mcpDirectoryCopy`, used by Tasks 5–7.

- [ ] **Step 1: English (add to the PR 3 object)**

```js
  sourceCard: "Search the directory",
  sourceCardHint: "Servers listed in the MCP Registry by their makers.",
  turnedOff: "Directory turned off",
  openSettings: "Open Settings",
  unreachable: "Directory not reachable right now",
  title: "Search the directory",
  helper: (host) =>
    `The MCP Registry lists servers published by their makers. A listing is not a security review. Your search is sent to ${host}.`,
  searchLabel: "Server name",
  searchButton: "Search",
  emptyHint: "Search matches server names only, for example “github” or “filesystem”.",
  loading: "Searching the directory…",
  results: (count) => `${count} ${count === 1 ? "server" : "servers"} found`,
  noHit: "No server with this name in the directory.",
  noHitPackage: "Set up a package",
  noHitPaste: "Paste setup from a guide",
  failed: "The directory is not reachable right now. Try again, or set the server up another way.",
  tryAgain: "Try again",
  showMore: "Show more",
  filters: "Show",
  installable: "Installable here",
  all: "All",
  verified: "verified publisher",
  verifiedHint:
    "The registry checked that the publisher owns this namespace and package. Nobody reviewed the code.",
  deprecated: "Deprecated",
  version: (version) => `Version ${version}`,
  options: {
    npm: "npm package",
    pypi: "PyPI package",
    "remote-http": "Online (HTTP)",
    "remote-sse": "Online (SSE)",
    unsupported: (type) => `${type} – not supported`,
  },
  reasons: {
    registryType: "AgentPier installs npm and PyPI packages only.",
    registryBaseUrl: "The package comes from another registry than npm or PyPI.",
    identifier: "The package name is not valid.",
    version: "The listing does not name an exact version.",
    transport: "This way of running is not supported.",
    argument: "It needs a secret or your own value as an argument.",
    url: "The address is not a valid https address.",
  },
  detailClose: "Close",
  published: (date) => `Published ${date}`,
  status: { active: "Active", deprecated: "Deprecated" },
  sourceLink: (host) => `Source: ${host}`,
  website: (host) => `Website: ${host}`,
  linkNote: "Link given by the publisher, not verified.",
  howItRuns: "How it runs",
  settingsNeeded: "Settings it needs",
  noSettingsMarked: "The publisher did not mark which settings are required.",
  required: "Required",
  secret: "Secret",
  reviewNote:
    "A directory listing is not a security review. Check who published the package before you install it.",
  use: "Use this server",
  listedAs: (name, version) => `Listed in the directory as ${name} (${version}).`,
  useHints: "Use its setup hints",
  urlVariable: (name) => `Value for {${name}}`,
  addressPreview: (url) => `Address: ${url}`,
  updateAvailable: "Update available",
  listedVersion: (version) => `Version ${version} is listed in the directory.`,
  identifierHint: "The directory now lists another package for this server. Add it as a new server if you want to switch.",
  remoteHint: "The directory now lists another address for this server.",
```

- [ ] **Step 2: German (same keys and arguments)**

```js
  sourceCard: "Im Verzeichnis suchen",
  sourceCardHint: "Server, die ihre Hersteller im MCP-Registry eingetragen haben.",
  turnedOff: "Verzeichnis ausgeschaltet",
  openSettings: "Einstellungen öffnen",
  unreachable: "Verzeichnis gerade nicht erreichbar",
  title: "Im Verzeichnis suchen",
  helper: (host) =>
    `Im MCP-Registry tragen Hersteller ihre Server ein. Ein Eintrag ist keine Sicherheitsprüfung. Deine Suche wird an ${host} geschickt.`,
  searchLabel: "Servername",
  searchButton: "Suchen",
  emptyHint: "Die Suche findet nur Servernamen, zum Beispiel „github“ oder „filesystem“.",
  loading: "Verzeichnis wird durchsucht…",
  results: (count) => `${count} ${count === 1 ? "Server" : "Server"} gefunden`,
  noHit: "Kein Server mit diesem Namen im Verzeichnis.",
  noHitPackage: "Paket einrichten",
  noHitPaste: "Einrichtung aus einer Anleitung einfügen",
  failed:
    "Das Verzeichnis ist gerade nicht erreichbar. Versuch es noch einmal oder richte den Server anders ein.",
  tryAgain: "Erneut versuchen",
  showMore: "Mehr anzeigen",
  filters: "Anzeigen",
  installable: "Hier installierbar",
  all: "Alle",
  verified: "geprüfter Herausgeber",
  verifiedHint:
    "Das Registry hat geprüft, dass dem Herausgeber dieser Namensraum und das Paket gehören. Den Code hat niemand geprüft.",
  deprecated: "Veraltet",
  version: (version) => `Version ${version}`,
  options: {
    npm: "npm-Paket",
    pypi: "PyPI-Paket",
    "remote-http": "Online (HTTP)",
    "remote-sse": "Online (SSE)",
    unsupported: (type) => `${type} – nicht unterstützt`,
  },
  reasons: {
    registryType: "AgentPier installiert nur npm- und PyPI-Pakete.",
    registryBaseUrl: "Das Paket stammt aus einer anderen Registry als npm oder PyPI.",
    identifier: "Der Paketname ist ungültig.",
    version: "Der Eintrag nennt keine exakte Version.",
    transport: "Diese Art des Betriebs wird nicht unterstützt.",
    argument: "Er braucht ein Geheimnis oder einen eigenen Wert als Argument.",
    url: "Die Adresse ist keine gültige https-Adresse.",
  },
  detailClose: "Schließen",
  published: (date) => `Veröffentlicht am ${date}`,
  status: { active: "Aktiv", deprecated: "Veraltet" },
  sourceLink: (host) => `Quelle: ${host}`,
  website: (host) => `Website: ${host}`,
  linkNote: "Link vom Herausgeber, nicht geprüft.",
  howItRuns: "So läuft er",
  settingsNeeded: "Diese Einstellungen braucht er",
  noSettingsMarked: "Der Herausgeber hat nicht markiert, welche Einstellungen nötig sind.",
  required: "Pflicht",
  secret: "Geheim",
  reviewNote:
    "Ein Verzeichniseintrag ist keine Sicherheitsprüfung. Prüfe vor der Installation, wer das Paket veröffentlicht hat.",
  use: "Diesen Server verwenden",
  listedAs: (name, version) => `Im Verzeichnis eingetragen als ${name} (${version}).`,
  useHints: "Seine Einrichtungshinweise verwenden",
  urlVariable: (name) => `Wert für {${name}}`,
  addressPreview: (url) => `Adresse: ${url}`,
  updateAvailable: "Update verfügbar",
  listedVersion: (version) => `Version ${version} ist im Verzeichnis eingetragen.`,
  identifierHint:
    "Das Verzeichnis nennt jetzt ein anderes Paket für diesen Server. Füg es als neuen Server hinzu, wenn du wechseln willst.",
  remoteHint: "Das Verzeichnis nennt jetzt eine andere Adresse für diesen Server.",
```

- [ ] **Step 3: Run the catalog tests**

Run: `node --test tests/unit/i18n-catalogs.test.js tests/unit/i18n-terminology.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/lib/i18n
git commit -m "feat: add the MCP directory screen copy in English and German

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Directory search and detail screens

**Files:**

- Create: `web/features/mcp-servers/wizard/directory-api.js`, `useDirectoryStatus.js`, `DirectoryStep.jsx`, `DirectoryResult.jsx`, `DirectoryDetail.jsx`; `tests/browser/mcp-directory-fixture.js`, `tests/browser/mcp-directory.spec.js`
- Modify: `web/features/mcp-servers/wizard/SourceStep.jsx`, `McpWizard.jsx` (`screens.directory`), `mcp-wizard.css`

**Interfaces:**

- Consumes: `/api/mcp-directory/status|servers|servers/:name` (PR 3); `draftFromEntry`, `isSelectable` (Task 3); copy (Task 4); `Sheet`, `SidePanel`; `useNarrowViewport` (`web/features/accounts/useNarrowViewport.js`).
- Produces: `directoryApi = { status(), search(search, cursor), detail(name), updates() }`; `useDirectoryStatus() → { status: {enabled, host, reachable}|null, error }`; the wizard screen `directory`.

- [ ] **Step 1: Browser fixture and failing spec**

`tests/browser/mcp-directory-fixture.js`:

```js
import { wizardSetup } from "./mcp-wizard-fixture.js";

/** A registry entry as PR 3's DTO, built from the server-side normaliser's fixtures. */
export const dto = {
  opnsense: {
    name: "io.github.example/opnsense-mcp-server",
    title: "OPNsense",
    description: "Manage an OPNsense firewall: rules, aliases, DHCP and diagnostics.",
    version: "0.4.1",
    namespace: "io.github.example",
    status: "active",
    statusMessage: "",
    publishedAt: "2025-10-01T10:00:00Z",
    repositoryUrl: "https://github.com/example/opnsense-mcp-server",
    websiteUrl: null,
    installable: true,
    options: [
      {
        kind: "npm",
        identifier: "opnsense-mcp-server",
        version: "0.4.1",
        transport: "stdio",
        url: null,
        urlVariables: [],
        packageArgs: [],
        ignored: ["runtimeHint"],
        unsupportedReason: null,
        headers: [],
        env: [
          {
            name: "OPNSENSE_URL",
            description: "Address of your OPNsense",
            required: true,
            secret: false,
            format: "string",
            default: null,
            choices: [],
            value: null,
            variables: [],
          },
          {
            name: "OPNSENSE_API_KEY",
            description: "API key from OPNsense",
            required: true,
            secret: true,
            format: "string",
            default: null,
            choices: [],
            value: null,
            variables: [],
          },
          {
            name: "OPNSENSE_ALLOW_WRITES",
            description: "Allow write access",
            required: false,
            secret: false,
            format: "boolean",
            default: "false",
            choices: [],
            value: null,
            variables: [],
          },
        ],
      },
      {
        kind: "unsupported",
        registryType: "oci",
        identifier: "ghcr.io/example/opnsense-mcp-server",
        version: "0.4.1",
        transport: "stdio",
        url: null,
        urlVariables: [],
        packageArgs: [],
        ignored: [],
        env: [],
        headers: [],
        unsupportedReason: "registryType",
      },
    ],
  },
  container: {
    name: "io.github.example/container-only",
    title: "",
    description: "Runs only as a container.",
    version: "1.0.0",
    namespace: "io.github.example",
    status: "deprecated",
    statusMessage: "Moved.",
    publishedAt: null,
    repositoryUrl: null,
    websiteUrl: null,
    installable: false,
    options: [
      {
        kind: "unsupported",
        registryType: "oci",
        identifier: "docker.io/example/server",
        version: "1.0.0",
        transport: "stdio",
        url: null,
        urlVariables: [],
        packageArgs: [],
        ignored: [],
        env: [],
        headers: [],
        unsupportedReason: "registryType",
      },
    ],
  },
  files: {
    name: "com.pulsemcp/remote-filesystem",
    title: "",
    description: "Read and write files in a hosted workspace.",
    version: "1.2.0",
    namespace: "com.pulsemcp",
    status: "active",
    statusMessage: "",
    publishedAt: "2025-11-01T00:00:00Z",
    repositoryUrl: null,
    websiteUrl: null,
    installable: true,
    options: [
      {
        kind: "remote-http",
        identifier: "",
        version: "",
        transport: "http",
        url: "https://{tenant}.files.example.test/mcp",
        urlVariables: [
          {
            name: "tenant",
            description: "Your tenant id",
            required: true,
            secret: false,
            default: null,
            choices: [],
          },
        ],
        packageArgs: [],
        ignored: [],
        env: [],
        headers: [
          {
            name: "Authorization",
            description: "Bearer token",
            required: true,
            secret: true,
            format: "string",
            default: null,
            choices: [],
            value: "Bearer {token}",
            variables: [],
          },
        ],
        unsupportedReason: null,
      },
    ],
  },
};

/** The wizard fixture plus /api/mcp-directory/*. `state.directory` drives the answers. */
export async function directorySetup(page, options = {}) {
  const state = await wizardSetup(page, options);
  state.directory = {
    status: { enabled: true, host: "registry.modelcontextprotocol.io", reachable: true },
    pages: { "": [[dto.opnsense, dto.container, dto.files]] },
    fail: null,
    updates: [],
    ...options.directory,
  };
  await page.route(/\/api\/mcp-directory\//, (route) => {
    const url = new URL(route.request().url());
    state.requests.push({
      method: "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    });
    const d = state.directory;
    if (url.pathname === "/api/mcp-directory/status")
      return route.fulfill({ json: d.status });
    if (url.pathname === "/api/mcp-directory/updates")
      return route.fulfill({ json: { updates: d.updates } });
    if (d.fail) return route.fulfill(d.fail);
    if (url.pathname === "/api/mcp-directory/servers") {
      const pages = d.pages[url.searchParams.get("search")] ?? d.pages[""] ?? [[]];
      const index = Number(url.searchParams.get("cursor") || 0);
      return route.fulfill({
        json: {
          entries: pages[index] ?? [],
          nextCursor: index + 1 < pages.length ? String(index + 1) : null,
        },
      });
    }
    const name = decodeURIComponent(
      url.pathname.slice("/api/mcp-directory/servers/".length),
    );
    const entry = Object.values(dto).find((item) => item.name === name);
    return route.fulfill(
      entry
        ? { json: entry }
        : {
            status: 404,
            json: {
              code: "MCP_DIRECTORY_NOT_FOUND",
              error: "x",
              messageKey: "mcpDirectory.notFound",
            },
          },
    );
  });
  return state;
}
```

`tests/browser/mcp-directory.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { fits, openWizard, phone, primary, writes } from "./mcp-wizard-fixture.js";
import { directorySetup, dto } from "./mcp-directory-fixture.js";

async function search(page, term = "opnsense") {
  const wizard = await openWizard(page);
  await wizard.getByRole("radio", { name: /Search the directory/ }).check();
  await wizard.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    wizard.getByText(/Your search is sent to registry\.modelcontextprotocol\.io/),
  ).toBeVisible();
  await expect(wizard.getByText(/Search matches server names only/)).toBeVisible();
  await wizard.getByLabel("Server name").fill(term);
  await wizard.getByRole("button", { name: "Search", exact: true }).click();
  return wizard;
}

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("results show what can run here; All shows the rest greyed", async ({
      page,
    }) => {
      await directorySetup(page);
      const wizard = await search(page);
      await expect(wizard.getByRole("status")).toHaveText("2 servers found");
      const card = wizard.getByRole("article", { name: "OPNsense" });
      await expect(card.getByText("io.github.example")).toBeVisible();
      await expect(card.getByText("npm package")).toBeVisible();
      await expect(card.getByText("oci – not supported")).toHaveClass(/is-unsupported/);
      await expect(wizard.getByRole("article", { name: /container-only/ })).toHaveCount(
        0,
      );
      await wizard.getByRole("button", { name: "All", exact: true }).click();
      await expect(
        wizard.getByRole("button", { name: "All", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      const container = wizard.getByRole("article", { name: /container-only/ });
      await expect(container.getByText("Deprecated")).toBeVisible();
      await fits(page);
    });

    test("the detail explains verification and never installs by itself", async ({
      page,
    }) => {
      const state = await directorySetup(page);
      const wizard = await search(page);
      await wizard
        .getByRole("article", { name: "OPNsense" })
        .getByRole("button", { name: "OPNsense" })
        .click();
      const detail = page.getByRole("dialog", { name: "OPNsense" });
      await expect(detail.getByText(/Nobody reviewed the code/)).toBeVisible();
      await expect(
        detail.getByRole("link", {
          name: "Source: github.com/example/opnsense-mcp-server",
        }),
      ).toHaveAttribute("rel", "noopener noreferrer");
      await expect(
        detail.getByText("Link given by the publisher, not verified."),
      ).toBeVisible();
      const ways = detail.getByRole("group", { name: "How it runs" });
      await expect(ways.getByRole("radio", { name: /npm package/ })).toBeChecked();
      await expect(
        ways.getByRole("radio", { name: /oci – not supported/ }),
      ).toBeDisabled();
      await expect(
        ways.getByText("AgentPier installs npm and PyPI packages only."),
      ).toBeVisible();
      await expect(detail.getByText("OPNSENSE_API_KEY")).toBeVisible();
      await expect(
        detail.getByText(/A directory listing is not a security review/),
      ).toBeVisible();
      await detail.getByRole("button", { name: "Use this server" }).click();
      await expect(
        wizard.getByRole("heading", {
          level: 1,
          name: "Settings for opnsense-mcp-server",
        }),
      ).toBeVisible();
      expect(writes(state)).toEqual([]);
      const key = wizard.locator(".mcp-setting", { hasText: "OPNSENSE_API_KEY" });
      await expect(key.getByText("API key from OPNsense")).toBeVisible();
      await expect(key.getByText("Required")).toBeVisible();
    });

    test("an unreachable directory offers Try again; paging shows more", async ({
      page,
    }) => {
      const state = await directorySetup(page, {
        directory: { pages: { opnsense: [[dto.opnsense], [dto.files]] } },
      });
      state.directory.fail = {
        status: 503,
        json: {
          code: "MCP_DIRECTORY_UNAVAILABLE",
          error: "x",
          messageKey: "mcpDirectory.unavailable",
        },
      };
      const wizard = await search(page);
      await expect(wizard.getByRole("alert")).toContainText(
        "The directory is not reachable right now. Try again, or set the server up another way.",
      );
      state.directory.fail = null;
      await wizard.getByRole("button", { name: "Try again" }).click();
      await expect(wizard.getByRole("article", { name: "OPNsense" })).toBeVisible();
      await wizard.getByRole("button", { name: "Show more" }).click();
      await expect(
        wizard.getByRole("article", { name: /remote-filesystem/ }),
      ).toBeVisible();
    });

    test("no hit offers the other ways", async ({ page }) => {
      await directorySetup(page, { directory: { pages: { nothing: [[]] } } });
      const wizard = await search(page, "nothing");
      await expect(
        wizard.getByText("No server with this name in the directory."),
      ).toBeVisible();
      await wizard.getByRole("button", { name: "Set up a package" }).click();
      await expect(
        wizard.getByRole("heading", { level: 1, name: "Which package?" }),
      ).toBeVisible();
    });

    test("a turned-off or unreachable directory is named on the Source card", async ({
      page,
    }) => {
      await directorySetup(page, {
        directory: {
          status: {
            enabled: false,
            host: "registry.modelcontextprotocol.io",
            reachable: false,
          },
        },
      });
      const wizard = await openWizard(page);
      await expect(
        wizard.getByRole("radio", { name: /Search the directory/ }),
      ).toBeDisabled();
      await expect(wizard.getByText("Directory turned off")).toBeVisible();
      await expect(wizard.getByRole("link", { name: "Open Settings" })).toBeVisible();
    });
  });
}
```

Run: `npm run build && npx playwright test tests/browser/mcp-directory.spec.js`
Expected: FAIL – no directory card.

- [ ] **Step 2: API client and status hook**

`web/features/mcp-servers/wizard/directory-api.js`:

```js
import api from "../../../lib/api.js";

export const directoryApi = {
  status: () => api("/mcp-directory/status"),
  search: (search, cursor = "") =>
    api(
      `/mcp-directory/servers?search=${encodeURIComponent(search)}${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    ),
  detail: (name) => api(`/mcp-directory/servers/${encodeURIComponent(name)}`),
  updates: () => api("/mcp-directory/updates"),
};
```

`web/features/mcp-servers/wizard/useDirectoryStatus.js`:

```js
import { useEffect, useState } from "react";
import { directoryApi } from "./directory-api.js";

/** Whether the directory card can be used: on, and the registry answered its health check. */
export default function useDirectoryStatus() {
  const [state, setState] = useState({ status: null, error: "" });
  useEffect(() => {
    let live = true;
    directoryApi.status().then(
      (status) => live && setState({ status, error: "" }),
      (failure) => live && setState({ status: null, error: failure.message }),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}
```

- [ ] **Step 3: Source card**

In `SourceStep.jsx` add the directory card first in `cards` and render its state:

```jsx
const directory = useDirectoryStatus();
const usable = directory.status?.enabled && directory.status.reachable;
```

```jsx
<label className={`mcp-wizard-card${usable ? "" : " is-disabled"}`}>
  <input
    type="radio"
    name="mcp-wizard-source"
    value="directory"
    disabled={!usable}
    checked={choice === "directory"}
    onChange={() => setChoice("directory")}
  />
  <span className="mcp-wizard-card-title">{directoryCopy.sourceCard}</span>
  <small className="mcp-hint">
    {directory.status && !directory.status.enabled ? (
      <>
        {directoryCopy.turnedOff}{" "}
        <a
          href={routePath(settingsRoute)}
          onClick={(event) => {
            event.preventDefault();
            navigate(settingsRoute);
          }}
        >
          {directoryCopy.openSettings}
        </a>
      </>
    ) : directory.status && !directory.status.reachable ? (
      directoryCopy.unreachable
    ) : (
      directoryCopy.sourceCardHint
    )}
  </small>
</label>
```

where `const settingsRoute = tabRoot("workspace");` (`web/features/settings/settings-navigation.js`) and `routePath` comes from `web/app/routes.js`. On submit with `choice === "directory"`: `dispatch({ type: "via", via: "directory" }); go("directory");`. `navigate` is in StepProps.

- [ ] **Step 4: Result card and detail**

`web/features/mcp-servers/wizard/DirectoryResult.jsx`:

```jsx
import React, { useId } from "react";
import { mcpDirectoryCopy as copy } from "../../../lib/i18n/messages/mcp-directory.js";

export const optionChip = (option) =>
  option.kind === "unsupported"
    ? copy.options.unsupported(option.registryType || option.transport)
    : copy.options[option.kind];

/** One search hit: title or name, namespace, description, ways to run, version. */
export default function DirectoryResult({ entry, onOpen }) {
  const id = useId();
  const title = entry.title || entry.name;
  return (
    <article className="mcp-directory-result" aria-labelledby={id}>
      <button type="button" id={id} className="mcp-directory-open" onClick={onOpen}>
        {title}
      </button>
      <p className="mcp-hint">
        <span className="mcp-wizard-mono">{entry.namespace}</span> · {copy.verified}
      </p>
      {entry.description && <p>{entry.description}</p>}
      <ul className="mcp-directory-chips" aria-label={copy.howItRuns}>
        {entry.options.map((option, index) => (
          <li
            key={index}
            className={
              option.kind === "unsupported"
                ? "list-row-pill is-unsupported"
                : "list-row-pill"
            }
          >
            {optionChip(option)}
          </li>
        ))}
        {entry.status === "deprecated" && (
          <li className="list-row-pill is-warning">{copy.deprecated}</li>
        )}
      </ul>
      <p className="mcp-hint">{copy.version(entry.version)}</p>
    </article>
  );
}
```

`web/features/mcp-servers/wizard/DirectoryDetail.jsx`:

```jsx
import React, { useState } from "react";
import Sheet from "../../../components/Sheet.jsx";
import SidePanel from "../../../components/SidePanel.jsx";
import { locale } from "../../../lib/i18n/index.js";
import { mcpDirectoryCopy as copy } from "../../../lib/i18n/messages/mcp-directory.js";
import useNarrowViewport from "../../accounts/useNarrowViewport.js";
import { linkLabel } from "./PackageStep.jsx";
import { optionChip } from "./DirectoryResult.jsx";
import { isSelectable } from "./directory-draft.js";

function Body({ entry, onUse }) {
  const first = entry.options.findIndex(isSelectable);
  const [chosen, setChosen] = useState(first);
  const option = entry.options[chosen];
  const inputs = option ? [...option.env, ...option.headers, ...option.urlVariables] : [];
  const marked = inputs.some((item) => item.required);
  return (
    <div className="mcp-directory-detail">
      <p className="mcp-hint">
        <span className="mcp-wizard-mono">{entry.namespace}</span> · {copy.verified}
      </p>
      <p className="mcp-hint">{copy.verifiedHint}</p>
      <p className="mcp-hint">
        {copy.status[entry.status]}
        {entry.publishedAt &&
          ` · ${copy.published(new Date(entry.publishedAt).toLocaleDateString(locale))}`}
      </p>
      {entry.statusMessage && <p className="mcp-warning">{entry.statusMessage}</p>}
      {entry.description && <p>{entry.description}</p>}
      {[
        ["repositoryUrl", copy.sourceLink],
        ["websiteUrl", copy.website],
      ].map(
        ([key, label]) =>
          entry[key] && (
            <p key={key} className="mcp-hint">
              <a href={entry[key]} target="_blank" rel="noopener noreferrer">
                {label(linkLabel(entry[key]))}
              </a>{" "}
              <small>{copy.linkNote}</small>
            </p>
          ),
      )}
      <fieldset className="mcp-wizard-cards">
        <legend>{copy.howItRuns}</legend>
        {entry.options.map((item, index) => (
          <label
            key={index}
            className={`mcp-wizard-card${isSelectable(item) ? "" : " is-disabled"}`}
          >
            <input
              type="radio"
              name={`directory-${entry.name}`}
              disabled={!isSelectable(item)}
              checked={index === chosen}
              onChange={() => setChosen(index)}
            />
            <span className="mcp-wizard-card-title">
              {optionChip(item)}
              {item.identifier && (
                <span className="mcp-wizard-mono"> {item.identifier}</span>
              )}
            </span>
            {!isSelectable(item) && (
              <small className="mcp-hint">{copy.reasons[item.unsupportedReason]}</small>
            )}
          </label>
        ))}
      </fieldset>
      <section aria-labelledby="directory-settings">
        <h3 id="directory-settings" className="mcp-wizard-subtitle">
          {copy.settingsNeeded}
        </h3>
        {!marked && <p className="mcp-hint">{copy.noSettingsMarked}</p>}
        <ul className="mcp-wizard-notes">
          {inputs.map((item) => (
            <li key={item.name}>
              <code className="mcp-wizard-mono">{item.name}</code>
              {item.required && <span className="list-row-pill">{copy.required}</span>}
              {item.secret && <span className="list-row-pill">{copy.secret}</span>}
              {item.description && <span className="mcp-hint"> {item.description}</span>}
            </li>
          ))}
        </ul>
      </section>
      <p className="mcp-hint">{copy.reviewNote}</p>
      <button
        type="button"
        className="button primary"
        disabled={!option || !isSelectable(option)}
        onClick={() => onUse(option)}
      >
        {copy.use}
      </button>
    </div>
  );
}

/** The entry's detail: a sheet on phones, a side panel on wider screens. */
export default function DirectoryDetail({ entry, onUse, onClose }) {
  const narrow = useNarrowViewport();
  if (!entry) return null;
  const title = entry.title || entry.name;
  return narrow ? (
    <Sheet open title={title} onCancel={onClose}>
      <Body entry={entry} onUse={onUse} />
    </Sheet>
  ) : (
    <SidePanel title={title} close={onClose}>
      <Body entry={entry} onUse={onUse} />
    </SidePanel>
  );
}
```

`SidePanel` (`title`, `close`, `footer`, `children`) and `Sheet` both render a modal `<dialog>` labelled by the title, so the spec's `getByRole("dialog", { name })` matches on both viewports.

- [ ] **Step 5: The search step**

`web/features/mcp-servers/wizard/DirectoryStep.jsx`:

```jsx
import React, { useId, useState } from "react";
import { mcpDirectoryCopy as copy } from "../../../lib/i18n/messages/mcp-directory.js";
import { routePath } from "../../../app/routes.js";
import { tabRoot } from "../../settings/settings-navigation.js";
import DirectoryDetail from "./DirectoryDetail.jsx";
import DirectoryResult from "./DirectoryResult.jsx";
import { directoryApi } from "./directory-api.js";
import { draftFromEntry } from "./directory-draft.js";
import useDirectoryStatus from "./useDirectoryStatus.js";
import WizardStep from "./WizardStep.jsx";

/** Search the MCP Registry; a hit opens its detail; "Use this server" fills the draft. */
const settingsRoute = tabRoot("workspace");

export default function DirectoryStep({ dispatch, go, headingRef, data, navigate }) {
  const id = useId();
  const directory = useDirectoryStatus();
  const [term, setTerm] = useState("");
  const [filter, setFilter] = useState("installable");
  const [state, setState] = useState({
    phase: "idle",
    entries: [],
    cursor: null,
    error: null,
  });
  const [detail, setDetail] = useState(null);
  const run = async (cursor = "") => {
    setState((current) => ({
      ...current,
      phase: "loading",
      error: null,
      ...(cursor ? {} : { entries: [] }),
    }));
    try {
      const page = await directoryApi.search(term.trim(), cursor);
      setState((current) => ({
        phase: "done",
        entries: cursor ? [...current.entries, ...page.entries] : page.entries,
        cursor: page.nextCursor,
        error: null,
      }));
    } catch (error) {
      setState((current) => ({ ...current, phase: "failed", error }));
    }
  };
  const open = async (entry) => {
    try {
      setDetail(await directoryApi.detail(entry.name));
    } catch (error) {
      setState((current) => ({ ...current, phase: "failed", error }));
    }
  };
  const use = (option) => {
    const taken = (data.mcpServers || []).map((server) => server.name);
    const draft = draftFromEntry(detail, option, { taken });
    setDetail(null);
    dispatch({ type: "fromDirectory", draft });
    go(draft.path === "remote" && draft.urlTemplate ? "remote" : "settings");
  };
  const shown = state.entries.filter((entry) => filter === "all" || entry.installable);
  const disabled = state.error?.code === "MCP_DIRECTORY_DISABLED";
  return (
    <WizardStep
      title={copy.title}
      headingRef={headingRef}
      onSubmit={() => term.trim() && run()}
    >
      <p className="mcp-hint">{copy.helper(directory.status?.host ?? "")}</p>
      <div className="mcp-directory-search">
        <label htmlFor={`${id}-search`}>{copy.searchLabel}</label>
        <input
          id={`${id}-search`}
          type="search"
          value={term}
          maxLength={100}
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => setTerm(event.target.value)}
        />
        <button type="submit" className="button secondary">
          {copy.searchButton}
        </button>
      </div>
      <div className="mcp-directory-filters" role="group" aria-label={copy.filters}>
        {[
          ["installable", copy.installable],
          ["all", copy.all],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="button chip"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <p role="status" className="mcp-hint">
        {state.phase === "idle"
          ? copy.emptyHint
          : state.phase === "loading"
            ? copy.loading
            : state.phase === "done" && shown.length
              ? copy.results(shown.length)
              : ""}
      </p>
      {state.phase === "loading" && !state.entries.length && (
        <div aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="mcp-directory-skeleton" />
          ))}
        </div>
      )}
      {state.phase === "failed" && (
        <div role="alert" className="mcp-field-error">
          {disabled ? copy.turnedOff : copy.failed}{" "}
          {disabled ? (
            <a
              href={routePath(settingsRoute)}
              onClick={(event) => {
                event.preventDefault();
                navigate(settingsRoute);
              }}
            >
              {copy.openSettings}
            </a>
          ) : (
            <button type="button" className="button secondary" onClick={() => run()}>
              {copy.tryAgain}
            </button>
          )}
        </div>
      )}
      {state.phase === "done" && !shown.length && (
        <div className="mcp-wizard-notice">
          <p>{copy.noHit}</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              dispatch({ type: "choose", path: "package" });
              go("package");
            }}
          >
            {copy.noHitPackage}
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              dispatch({ type: "via", via: "paste" });
              go("paste");
            }}
          >
            {copy.noHitPaste}
          </button>
        </div>
      )}
      <div className="mcp-directory-results">
        {shown.map((entry) => (
          <DirectoryResult key={entry.name} entry={entry} onOpen={() => open(entry)} />
        ))}
      </div>
      {state.cursor && state.phase !== "loading" && (
        <button
          type="button"
          className="button secondary"
          onClick={() => run(state.cursor)}
        >
          {copy.showMore}
        </button>
      )}
      <DirectoryDetail entry={detail} onUse={use} onClose={() => setDetail(null)} />
    </WizardStep>
  );
}
```

A search answered with `409 MCP_DIRECTORY_DISABLED` shows "Directory turned off" with **Open Settings** (Review Focus 4). Register `directory: DirectoryStep` in `screens`. CSS: `.mcp-directory-search { display: grid; grid-template-columns: 1fr auto; gap: 8px; }`, `.mcp-directory-filters { display: flex; gap: 8px; }`, `.mcp-directory-filters .button[aria-pressed="true"] { border-color: var(--accent); }`, `.mcp-directory-result { display: grid; gap: 4px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; }`, `.mcp-directory-open { text-align: left; font-weight: 600; min-height: 44px; overflow-wrap: anywhere; }`, `.mcp-directory-chips { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; padding: 0; margin: 0; }`, `.is-unsupported { opacity: 0.55; }`, `.mcp-directory-skeleton { height: 88px; border-radius: 12px; background: var(--surface-muted); margin-bottom: 12px; }`.

- [ ] **Step 6: Run to verify it passes**

Run: `npm run build && npx playwright test tests/browser/mcp-directory.spec.js`
Expected: PASS on desktop and phone.

- [ ] **Step 7: Commit**

```bash
git add web/features/mcp-servers/wizard tests/browser/mcp-directory-fixture.js tests/browser/mcp-directory.spec.js
git commit -m "feat: search the MCP directory and start a setup from an entry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Directory hints in set-up, URL templates, origin in the save

**Files:**

- Modify: `web/features/mcp-servers/wizard/PackageStep.jsx`, `RemoteStep.jsx`, `SettingsStep.jsx`, `wizard-save.js`, `web/features/mcp-servers/mcp-server-save.js`, `tests/unit/mcp-server-save.test.js`, `tests/unit/mcp-wizard-save.test.js`, `tests/browser/mcp-directory.spec.js`

**Interfaces:**

- Consumes: `draft.hints.directory`, `draft.urlTemplate`, `draft.directoryOrigin` (Task 3); `composeUrl`.
- Produces: `mcpServerStep({ …, directoryOrigin })` sends `directoryOrigin` in a create body; `saveNewServer` passes `draft.directoryOrigin`.

- [ ] **Step 1: Failing tests**

Unit (append to `tests/unit/mcp-server-save.test.js`):

```js
test("a create from the directory carries its origin entry", async () => {
  const bodies = [];
  const values = { ...mcpServerValues(null), name: "docs", url: "https://a.example/mcp" };
  await mcpServerStep({
    server: null,
    label: "",
    origin: "directory",
    directoryOrigin: { name: "a.b/c", version: "1.0.0" },
    saveServer: async (_s, body) => {
      bodies.push(body);
      return { id: "s1" };
    },
    saved: async () => {},
  }).run({ values, confirmations: {} });
  assert.deepEqual(bodies[0].directoryOrigin, { name: "a.b/c", version: "1.0.0" });
  assert.equal(bodies[0].origin, "directory");
});
```

Browser (append inside the describe of `tests/browser/mcp-directory.spec.js`):

```js
test("a remote entry composes its address from the variables and saves its origin", async ({
  page,
}) => {
  const state = await directorySetup(page);
  const wizard = await search(page, "files");
  await wizard
    .getByRole("article", { name: /remote-filesystem/ })
    .getByRole("button")
    .first()
    .click();
  await page
    .getByRole("dialog", { name: /remote-filesystem/ })
    .getByRole("button", { name: "Use this server" })
    .click();
  await expect(page).toHaveURL(/step=remote/);
  await wizard.getByLabel("Value for {tenant}").fill("acme corp");
  await expect(
    wizard.getByText("Address: https://acme%20corp.files.example.test/mcp"),
  ).toBeVisible();
  await expect(
    wizard.getByText(/Listed in the directory as com\.pulsemcp\/remote-filesystem/),
  ).toBeVisible();
  await primary(wizard).click();
  const auth = wizard.locator(".mcp-setting", { hasText: "Authorization" });
  await auth.getByLabel("Value", { exact: true }).fill("tok");
  await primary(wizard).click();
  await wizard.getByRole("button", { name: "Save server" }).click();
  const created = writes(state).find((r) => r.path === "/api/mcp-servers");
  expect(created.body).toMatchObject({
    url: "https://acme%20corp.files.example.test/mcp",
    headers: { Authorization: "Bearer tok" },
    origin: "directory",
    directoryOrigin: { name: "com.pulsemcp/remote-filesystem", version: "1.2.0" },
  });
});

test("the package step names the directory entry and can drop its hints", async ({
  page,
}) => {
  await directorySetup(page);
  const wizard = await search(page);
  await wizard
    .getByRole("article", { name: "OPNsense" })
    .getByRole("button", { name: "OPNsense" })
    .click();
  await page
    .getByRole("dialog", { name: "OPNsense" })
    .getByRole("button", { name: "Use this server" })
    .click();
  await wizard.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/step=package/);
  await expect(
    wizard.getByText(
      "Listed in the directory as io.github.example/opnsense-mcp-server (0.4.1).",
    ),
  ).toBeVisible();
  const hints = wizard.getByRole("checkbox", { name: "Use its setup hints" });
  await expect(hints).toBeChecked();
  await hints.uncheck();
  await wizard.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    wizard
      .locator(".mcp-setting", { hasText: "OPNSENSE_API_KEY" })
      .getByText("No description"),
  ).toBeVisible();
});
```

Run: `node --test tests/unit/mcp-server-save.test.js && npm run build && npx playwright test tests/browser/mcp-directory.spec.js`
Expected: FAIL.

- [ ] **Step 2: Implement**

`mcp-server-save.js`: add `directoryOrigin = null` to the `mcpServerStep` parameters and `...(!server && directoryOrigin ? { directoryOrigin } : {}),` next to the `origin` line in the body.

`wizard-save.js`: pass `directoryOrigin: draft.directoryOrigin ?? null` in `step()` to `mcpServerStep`.

`PackageStep.jsx` – when `draft.hints.directory` exists, above the fields:

```jsx
{
  draft.hints.directory && (
    <div className="mcp-wizard-notice">
      <p>
        {directoryCopy.listedAs(
          draft.hints.directory.name,
          draft.hints.directory.version,
        )}
      </p>
      <label className="mcp-check">
        <input
          type="checkbox"
          checked={draft.hints.useDirectory !== false}
          onChange={(event) =>
            set("hints")({ ...draft.hints, useDirectory: event.target.checked })
          }
        />
        <span>{directoryCopy.useHints}</span>
      </label>
    </div>
  );
}
```

`SettingsStep.jsx` and `SettingRow`: read hints through one helper so the toggle applies everywhere:

```js
const hints = draft.hints.useDirectory === false ? {} : (draft.hints.settings ?? {});
```

(replace the existing `const hints = draft.hints.settings ?? {};` in `SettingsStep.jsx`; the `useDirectory` flag is only set by the package step, so paste hints are unaffected).

`RemoteStep.jsx` – when `draft.urlTemplate` exists, render one field per variable before the address and keep `draft.url` composed:

```jsx
{
  draft.urlTemplate && (
    <fieldset className="mcp-wizard-template">
      {draft.hints.directory && (
        <p className="mcp-hint">
          {directoryCopy.listedAs(
            draft.hints.directory.name,
            draft.hints.directory.version,
          )}
        </p>
      )}
      {draft.urlTemplate.variables.map((variable) => (
        <label key={variable.name}>
          {directoryCopy.urlVariable(variable.name)}
          <input
            value={draft.urlTemplate.values[variable.name] ?? ""}
            required={variable.required}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => {
              const urlTemplate = {
                ...draft.urlTemplate,
                values: {
                  ...draft.urlTemplate.values,
                  [variable.name]: event.target.value,
                },
              };
              set("urlTemplate")(urlTemplate);
              set("url")(composeUrl(urlTemplate));
            }}
          />
          {variable.description && (
            <small className="mcp-hint">{variable.description}</small>
          )}
        </label>
      ))}
      <p className="mcp-hint mcp-wizard-mono">
        {directoryCopy.addressPreview(draft.url)}
      </p>
    </fieldset>
  );
}
```

and make the address input `readOnly={Boolean(draft.urlTemplate)}` so the composed value is the one saved. Imports: `mcpDirectoryCopy as directoryCopy`, `composeUrl` from `./directory-draft.js`.

The remote draft from the directory keeps its sign-in header row with `key: "auth"` and `bearer: true`; `saveValues` composes `Bearer tok` (PR 1).

- [ ] **Step 3: Run to verify it passes**

Run: `node --test tests/unit/mcp-server-save.test.js tests/unit/mcp-wizard-save.test.js && npm run build && npx playwright test tests/browser/mcp-directory.spec.js tests/browser/mcp-wizard-*.spec.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/features/mcp-servers tests/unit/mcp-server-save.test.js tests/browser/mcp-directory.spec.js
git commit -m "feat: use a directory entry's hints and address template in the wizard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Update pill, package-panel hint, required markers in edit

**Files:**

- Create: `web/features/mcp-servers/wizard/useDirectoryUpdates.js`, `tests/browser/mcp-directory-updates.spec.js`
- Modify: `web/features/accounts/McpServersGroup.jsx`, `web/features/mcp-servers/McpPackagePanel.jsx`, `web/features/mcp-servers/wizard/McpServerOverview.jsx`, `web/features/mcp-servers/wizard/EditSettingsStep.jsx`, `web/features/mcp-servers/McpSecretRows.jsx`

**Interfaces:**

- Consumes: `GET /api/mcp-directory/updates` (Task 2), `directoryApi.detail` (Task 5).
- Produces: `useDirectoryUpdates(enabled) → Map<serverId, Update>`; `<McpPackagePanel listedVersion? />`; `<McpSecretRows requiredNames? />`.

- [ ] **Step 1: Failing browser spec**

`tests/browser/mcp-directory-updates.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { packagedServer, versions } from "./mcp-packages-fixture.js";
import { directorySetup, dto } from "./mcp-directory-fixture.js";

const fromDirectory = () =>
  packagedServer("ready", {
    name: "opnsense",
    source: {
      registry: "npm",
      name: "server-x",
      version: "1.0.0",
      status: "ready",
      leadingArgs: 1,
    },
    directoryOrigin: { name: dto.opnsense.name, version: "1.0.0" },
    envNames: ["OPNSENSE_API_KEY", "EXTRA"],
  });

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(label, () => {
    test.use(use);

    test("a newer directory version shows a pill and pre-fills the update", async ({
      page,
    }) => {
      const state = await directorySetup(page, {
        servers: [fromDirectory()],
        versions,
        directory: { updates: [{ serverId: "s1", version: "1.1.0" }] },
      });
      await page.goto(`${baseURL}/accounts?section=mcp-servers`);
      await expect(
        page.getByRole("link", { name: /^opnsense/ }).getByText("Update available"),
      ).toBeVisible();
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1`);
      const panel = page.locator(".mcp-package");
      await expect(
        panel.getByText("Version 1.1.0 is listed in the directory."),
      ).toBeVisible();
      await expect(panel.locator(".mcp-package-update select")).toHaveValue("1.1.0");
      expect(state.requests.some((r) => r.path === "/api/mcp-directory/updates")).toBe(
        true,
      );
    });

    test("a changed identifier is a hint, never a pre-filled version", async ({
      page,
    }) => {
      await directorySetup(page, {
        servers: [fromDirectory()],
        versions,
        directory: { updates: [{ serverId: "s1", hint: "identifier" }] },
      });
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1`);
      await expect(
        page.getByText(/now lists another package for this server/),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: /^opnsense/ }).getByText("Update available"),
      ).toHaveCount(0);
    });

    test("edit settings marks the directory's required names", async ({ page }) => {
      await directorySetup(page, { servers: [fromDirectory()] });
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1&step=settings`);
      const key = page.locator(".mcp-row", { hasText: "OPNSENSE_API_KEY" });
      await expect(key.getByText("Required")).toBeVisible();
      await expect(
        page.locator(".mcp-row", { hasText: "EXTRA" }).getByText("Required"),
      ).toHaveCount(0);
    });
  });
}
```

The list row lookup `getByRole("link", { name: /^opnsense/ })` follows `accountRow()` in `tests/helpers/accounts-browser.js`; on phones the list is the hub, so the first test works there too.

Run: `npm run build && npx playwright test tests/browser/mcp-directory-updates.spec.js`
Expected: FAIL.

- [ ] **Step 2: Implement**

`web/features/mcp-servers/wizard/useDirectoryUpdates.js`:

```js
import { useEffect, useState } from "react";
import { directoryApi } from "./directory-api.js";

/**
 * Directory updates by server id, asked once per mount of the MCP list or a server
 * overview (an owner action); only when some server came from the directory.
 */
export default function useDirectoryUpdates(servers) {
  const [updates, setUpdates] = useState(() => new Map());
  const wanted = (servers || []).some((server) => server.directoryOrigin);
  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    directoryApi.updates().then(
      (result) =>
        live &&
        setUpdates(
          new Map((result?.updates ?? []).map((update) => [update.serverId, update])),
        ),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [wanted]);
  return updates;
}
```

`McpServersGroup.jsx`: `const updates = useDirectoryUpdates(servers);` and in the row `sub`, after the stdio pill:

```jsx
{
  updates.get(server.id)?.version && (
    <span className="list-row-pill">{directoryCopy.updateAvailable}</span>
  );
}
```

`McpPackagePanel.jsx`: add the `listedVersion` prop. Pre-fill once the versions are loaded and before the owner chose one:

```js
useEffect(() => {
  if (listedVersion && versions.versions.some((entry) => entry.version === listedVersion))
    setVersion(listedVersion);
  else if (!version && versions.versions.length) setVersion(newestStable(versions));
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [versions, listedVersion]);
```

(replacing the existing "newest stable" effect), and render `{listedVersion && <p className="mcp-hint">{directoryCopy.listedVersion(listedVersion)}</p>}` above the update fields.

`McpServerOverview.jsx`: `const update = useDirectoryUpdates([server]).get(server.id);` pass `listedVersion={update?.version}` to `McpPackagePanel`, and render the hints:

```jsx
{
  update?.hint === "identifier" && (
    <p className="mcp-hint">{directoryCopy.identifierHint}</p>
  );
}
{
  update?.hint === "remote" && <p className="mcp-hint">{directoryCopy.remoteHint}</p>;
}
```

`McpSecretRows.jsx`: new prop `requiredNames = []`; in a stored row after `<code>{row.name}</code>` render `{requiredNames.includes(row.name) && <span className="list-row-pill">{mcpDirectoryCopy.required}</span>}`.

`EditSettingsStep.jsx`: when `server.directoryOrigin` is set, load the entry once and mark the required names of the option the server runs:

```js
const [requiredNames, setRequiredNames] = useState([]);
useEffect(() => {
  if (!server.directoryOrigin) return undefined;
  let live = true;
  directoryApi.detail(server.directoryOrigin.name).then(
    (entry) => {
      if (!live) return;
      const option =
        entry.options.find(
          (item) => server.source && item.kind === server.source.registry,
        ) ?? entry.options.find((item) => item.kind.startsWith("remote-"));
      const inputs = option
        ? server.transport === "stdio"
          ? option.env
          : option.headers
        : [];
      setRequiredNames(inputs.filter((item) => item.required).map((item) => item.name));
    },
    () => {},
  );
  return () => {
    live = false;
  };
}, [server.directoryOrigin?.name, server.source, server.transport]);
```

and pass `requiredNames={requiredNames}` to `McpSecretRows`. Opening an edit step is an owner action, so the request is allowed; a failure leaves no markers.

- [ ] **Step 3: Run to verify it passes**

Run: `npm run build && npx playwright test tests/browser/mcp-directory-updates.spec.js tests/browser/mcp-packages.spec.js tests/browser/mcp-wizard-edit.spec.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web tests/browser/mcp-directory-updates.spec.js
git commit -m "feat: show directory updates in the MCP list and package panel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation, final cleanup and PR

**Files:**

- Modify: `docs/mcp.md`, `docs/assistant-gateway.md` (only if its "Backups" section lists store columns), `README.md`/`README.de.md` (feature line, only if it should name the directory)
- Delete: `docs/superpowers/specs/2026-10-16-mcp-wizard-design.md`, `docs/superpowers/plans/2026-10-16-mcp-wizard-4-directory-ui.md`

- [ ] **Step 1: Document**

Extend `docs/mcp.md` "MCP directory" (from PR 3) with:

```markdown
On the wizard's Source step, **Search the directory** searches server names; the
default filter **Installable here** hides entries AgentPier cannot run (Docker/OCI,
NuGet, Cargo, MCPB), **All** shows them greyed with the reason. An entry's detail
names its publisher namespace (the registry verified namespace and package ownership;
nobody reviewed the code), its status, its source link (given by the publisher, not
verified), how it runs and the settings it needs. **Use this server** only fills in the
setup; installing still needs **Install** and binding still needs **Connect**. A server
set up from the directory remembers that entry (name and version, part of backups);
when the MCP list opens, AgentPier asks the directory for at most 20 such servers and
shows **Update available** when a newer exact version of the same package is listed.
The package panel then pre-fills that version for **Check update**. A different
package or address is shown as a hint only.
```

- [ ] **Step 2: Full verification**

Run: `npm run check && npm run build && npx playwright test tests/browser/mcp-*.spec.js tests/browser/agent-mcp-servers.spec.js && AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/mcp-directory*.spec.js tests/browser/mcp-wizard-*.spec.js`
Expected: PASS. Exercise the directory in English against the real registry once (`AGENTPIER_DATA_DIR=$(mktemp -d) npm start`, search "filesystem", open a detail, **Use this server**, stop before **Install**); take 390 px and desktop screenshots of search results and detail.

- [ ] **Step 3: Delete the spec and this plan; confirm no wizard plan is left**

```bash
ls docs/superpowers/plans/ | grep mcp-wizard
git rm docs/superpowers/specs/2026-10-16-mcp-wizard-design.md docs/superpowers/plans/2026-10-16-mcp-wizard-4-directory-ui.md
ls docs/superpowers/plans/ docs/superpowers/specs/ | grep mcp-wizard || echo "clean"
git add docs README.md README.de.md
git commit -m "docs: describe the MCP directory in the wizard and remove its design notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the first `ls` prints only `2026-10-16-mcp-wizard-4-directory-ui.md`; the last prints `clean`.

- [ ] **Step 4: Push and open the PR**

```bash
git fetch -q origin && git rebase origin/main
GIT_TERMINAL_PROMPT=0 git -c credential.helper='!gh auth git-credential' push -q -u origin feat/mcp-directory-ui
```

PR title: `feat: find MCP servers in the MCP Registry from the wizard`. Describe AGENTPIER-83/84, the screens, Q4/Q5/Q8/Q9 behaviour, that nothing installs from a listing, validation (commands, browsers), docs checked (`docs/mcp.md`, `docs/assistant-gateway.md`, `README.md`, `README.de.md`), screenshots from `agent-pier-assets`, and that this PR removes the spec and the last plan. Add for the release notes: the directory is a preview, and searches go to the configured registry host. End with the Claude Code line.

---

## Self-Review

1. **Spec coverage (stage 2b).** Source card states (Task 5), directory search with helper naming the host, chips, result cards, deprecated chip, empty/loading/no-hit/error/paging states (Task 5), detail with verified explanation, status/date, source link note, How it runs with greyed reasons, Settings it needs, neutral note, Use this server (Task 5), package-step directory hint (Task 6), URL templates (Tasks 3, 6), origin column + backup/restore (Task 1), list pill + package-panel hint and pre-fill + identifier/remote hints (Tasks 2, 7), required markers in edit (Task 7), docs and final cleanup (Task 8).
2. **Placeholders.** None. Task 1 tells the implementer to copy the backup/restore helper calls from `mcp-server-backup-crafted.test.js`, which is the reference for crafted-backup tests.
3. **Type consistency.** `directoryOrigin { name, version }` is the same in the store (Task 1), route (Task 2), draft (Task 3) and save body (Task 6); `Update { serverId, version } | { serverId, hint }` is used by Tasks 2 and 7.
4. **Deviation to confirm.** The spec says "list decoration for the update pill"; this plan serves it from a separate `GET /api/mcp-directory/updates` called when the list opens, so `GET /mcp-servers` (reloaded after every change) never waits for the registry.
