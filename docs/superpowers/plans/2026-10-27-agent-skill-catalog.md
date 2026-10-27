# Agent Skill Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner installs agent skills once into an AgentPier-owned catalog (SKILL.md, zip or GitHub repo, with scan, preview, digest and updates) and switches each one on per agent in **Agent › Skills** next to the bundled OpenClaw skills (AGENTPIER-182).

**Architecture:** The catalog lives in `<data>/assistants/skill-catalog/`: `catalog.json` (records), `store/<name>/<digest>/` (the immutable copy of the current version) and `skills/<name>/` (the live copy; the only directory OpenClaw scans, via the locked `skills.load.extraDirs`). Each agent's existing `agents.entries.<id>.skills` allow list selects catalog names exactly as it selects bundled names; the compile and live apply accept a catalog name only when OpenClaw resolves it to the catalog root. Every apply checks the live copy's digest against the record and restores it from `store/`. The install flow reuses `server/features/extensions/skill-*.js` (scan, preview, GitHub ref pinning, digest); same-name uploads and **Check for update** create a new version.

**Tech Stack:** Node.js ES modules, Express, React/JSX, `node:test`, Playwright, pinned OpenClaw 2026.10.7.

**Spec:** `docs/superpowers/specs/2026-10-27-agent-skill-catalog-design.md` (sections "Runtime mechanism" and "Corrections and calls" are binding).

## Global Constraints

- Owner only: catalog install, update, removal and every per-agent switch. Restricted users never switch skills on or off at any level; `/api/agent-skill-catalog*` stays out of `userRoutes` (`server/http/route-access.js`) and `"skills"` stays in `lockedKeys` (`server/features/users/user-agent-settings.js`).
- The hard lock still applies: a skill never brings shell or any tool `lockedEntry` (`server/features/users/user-agent-lock.js`) removes.
- Shell/program needs come from OpenClaw's `skills.status` (`requirements.bins`/`anyBins` → `usesShell`), not from AgentPier's content scan.
- Skills needing `skills.entries.<key>.env/apiKey` (report `requirements.env`, `requirements.config` or `primaryEnv`; frontmatter `metadata.openclaw.requires.env/config` or `primaryEnv`) install, show "needs settings — not supported yet" and are never compiled.
- Workspace skills are never used for the catalog; only the AgentPier-owned catalog root is in `skills.load.extraDirs`, and `skills.load` is a locked path.
- No automatic background update checks.
- Audit install, update, override and removal with ids and counts only (no names, paths, excerpts or content).
- Every UI string in German and English (`web/lib/i18n/{de,en}/`), reactive exports from `web/lib/i18n/messages/`; server messages in `server/lib/i18n/{de,en}/extensions.js`; run `npm run i18n:confirm` and commit both `translation-lock.json` files.
- UI only from `docs/ui-guide.md` components (`ListCard`, `ListRow`, `ToggleRow`, `SidePanel`, `ConfirmDialog`, `StatusChip`, `Segment`); no new hex colours, font sizes below 11px or breakpoints.
- Every source and test file ≤ 600 lines (`check:structure`). `server/features/assistants/assistant-service.js` (596) and `server/application/assistant-graph.js` (598) must not grow: wire the catalog from a new module instead.
- `server/features/assistants/runtime-config.js` keeps importing only Node built-ins (the installer loads it before `node_modules` exists).
- Commits: `feat:`/`fix:`/`chore:` prefixes, English, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions this plan makes where the spec leaves room

- **Page:** a fifth hub tab **Agents › Skills** (`/agents?tab=skills`, `agentsHubTabs` in `web/features/assistants/hub-routes.js`).
- **API:** `/api/agent-skill-catalog` (not below `/api/assistants/`, so it never collides with `/assistants/:id` and needs no owner-content classification), mounted inside `assistantRoutes` so it shares the dormant-feature handling.
- **Same name = update:** a preview whose name matches an existing catalog skill is an update of that skill (`replaces` in the preview). The spec's "refused at install if same name as another catalog skill" is read as "never a second skill of that name".
- **Clash refusal** (409 at preview): a name bundled by the installed runtime, found under `state/plugin-skills`, `state/skills`, `home/.agents/skills` or `home/.openclaw/skills` (`shadowingSkillNames`), or reported by a running Gateway's `skills.status({})` from any source other than the catalog.
- **Layout:** copies, no symlinks (no `allowSymlinkTargets`). Staging and the old copy during a swap live in `skill-catalog/staging/`, outside the scanned root, so OpenClaw never sees two `SKILL.md` with one name.
- **Versions kept:** only the current version's `store/<name>/<digest>/`; `sweep()` removes unreferenced versions, staging leftovers and live folders without a record.
- **Digest:** catalog digests ignore permission bits (`skillDigest(dir, { modes: false })`) because backups restore every file as 0600 (`server/features/operations/tar.js:224`); the record keeps `executables` and `verify` re-applies modes (files 0o400, executables 0o500, folders 0o700).
- **When the digest is checked:** in `AssistantConfig.applyOnce` for the agent's switched-on catalog names (it runs before every turn admission, including the unchanged-config shortcut) and for all catalog skills before every Gateway spawn. A live copy whose store copy is also tampered is removed and the skill becomes `damaged` (never compiled; "install again").
- **Update applies to every enabled agent** through OpenClaw's skills watcher (the allow lists do not change); no extra re-apply.
- **Runtime clash after an OpenClaw update:** a catalog name the runtime now bundles is shown `shadowed` (one row per name) and dropped from every compile; the bundled skill of that name cannot be switched on until the catalog skill is removed.
- **Workshop tier:** `skillShadowRoots` adds `state/agents/<runtimeAgentId>/agent/workshop-skills` (tier 5 outranks bundled and extra dirs); its signature takes the assistant.
- **Removal:** strips the name from every stored agent list through `AssistantStore.updateAssistant` (one retry on a revision conflict), then deletes files and record, then applies affected agents. Archived agents' stored lists are left; the compile drops names that are neither bundled nor in the catalog.
- **UI marks:** catalog rows on **Agent › Skills** carry "From the skill catalog"; a catalog skill with `usesShell` on an agent without shell shows "Works with limits: it runs programs and this agent has no shell access" (bundled rows keep "Needs shell access").
- **Catalog page requirements:** read from `skills.status({})` when the Gateway runs; otherwise "Shown once the agent service runs".
- **Native contract env:** the new contract reuses `AGENTPIER_SKILLS_CONTRACT_RUNTIME` (already provisioned by `scripts/provision-assistant-contracts.mjs`).

## Review Focus

1. A skill folder named like `redis-cache` or containing `node_modules/` — expected: in every backup and restored intact. `volatileTree` in `server/features/operations/assistant-backup.js` drops any `*cache`/`node_modules` segment today. (Test in Task 9.)
2. A backup restore that resets all files to 0600 — expected: catalog skills stay usable, not `damaged`, executables get their bit back. (Tests in Tasks 2 and 9.)
3. A crash or failure in the middle of an update swap — expected: the old version stays live or is restored; OpenClaw never sees two skills with one name; a retry works. (Test in Task 2.)
4. The same name uploaded again while an agent runs — expected: preview says "replaces version N", the agent's next turn reads the new content, its allow list is unchanged. (Tests in Tasks 3 and 6.)
5. A catalog skill's live copy edited by an agent with shell — expected: restored before that agent's next turn; if the store copy is damaged too, the skill is off everywhere and the catalog says "install again". (Tests in Tasks 2 and 6.)

---

### Task 1: Native contract stop-gate — catalog root in `extraDirs`, per-agent allow list

**Files:**
- Modify: `server/features/assistants/runtime-paths.js:18-25`
- Modify: `server/features/assistants/runtime-config.js:162-166` (compile `skills.load`)
- Modify: `server/features/assistants/openclaw-config/locked-core.js:27-28`
- Modify: `tests/helpers/assistant-shell-compiled.js:31-42` (optional `tool` hook)
- Create: `tests/integration/assistant-skill-catalog-contract.test.js`
- Modify: `scripts/assistant-contract-shards.json` (file + seconds)
- Test: `tests/unit/openclaw-locked-core.test.js`, `tests/unit/agent-skills.test.js` (compile)

**Interfaces:**
- Produces: `runtimePaths(dataDir).skillCatalog` = `<root>/skill-catalog`, `.catalogSkills` = `<root>/skill-catalog/skills` (both `privateFolder`); every compiled config has `skills.load = { extraDirs: [paths.catalogSkills], watch: true }`; `"skills.load"` in `lockedPaths`; `compiledShell(t, installed, { prefix, tool })` where `tool(input)` returning a call wins over the `[cmd:]` mapping.
- Produces: `catalogSource` constant (the `source` string OpenClaw reports for extra-dir skills) recorded in the contract diagnostics; Task 5 defines it in code.

- [ ] **Step 1: Write the failing unit tests**

```js
// tests/unit/openclaw-locked-core.test.js
test("skills.load is locked", () => {
  assert.equal(isLockedPath("skills.load"), true);
  assert.equal(isLockedPath("skills.load.extraDirs"), true);
});
// tests/unit/agent-skills.test.js (compile section)
test("every compile scans only the catalog root", () => {
  const paths = { workspaces: "/d/assistants/workspaces", logs: "/d/l",
    catalogSkills: "/d/assistants/skill-catalog/skills" };
  const config = compileOpenClawConfig({ existing: { skills: { load: { extraDirs: ["/x"] } } },
    paths, port: 1, token: "t", teams: null });
  assert.deepEqual(config.skills.load, { extraDirs: [paths.catalogSkills], watch: true });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test tests/unit/openclaw-locked-core.test.js tests/unit/agent-skills.test.js`
Expected: FAIL on both new tests.

- [ ] **Step 3: Implement** the two paths in `runtimePaths`, `"skills.load"` in `lockedPaths` (next to `skills.allowBundled`), and assign `config.skills.load` outright in `compileOpenClawConfig` right after `allowBundled` (same comment style: compiler-owned, never from overrides).

- [ ] **Step 4: Run the unit tests**

Run: `node --test tests/unit/openclaw-locked-core.test.js tests/unit/agent-skills.test.js`
Expected: PASS.

- [ ] **Step 5: Write the native contract (stop-gate)**

`tests/integration/assistant-skill-catalog-contract.test.js`, gated like `assistant-skills-contract.test.js` on `AGENTPIER_SKILLS_CONTRACT_RUNTIME`, timeout `contractTimeout(300000)`. Scenario, start compile only (the live apply drops non-bundled names until Task 6):

```js
const marker = "CATALOG-PROBE-7f3a";
// h = compiledShell(t, installed, { prefix: "skill-catalog-", tool: readTool })
fs.mkdirSync(path.join(h.runtime.paths.catalogSkills, "catalog-probe"), { recursive: true });
fs.writeFileSync(path.join(h.runtime.paths.catalogSkills, "catalog-probe", "SKILL.md"),
  `---\nname: catalog-probe\ndescription: Probe skill\n---\n${marker}\n`);
const a = h.create("Has"), b = h.create("Lacks");
h.store.updateAssistant(a.id, { skills: ["catalog-probe"] }, 1);
await h.runtime.start();
const report = (id) => h.runtime.client.call("skills.status", { agentId: id });
const onA = (await report(a.runtimeAgentId)).skills.find((s) => s.name === "catalog-probe");
t.diagnostic(`source=${onA.source} filePath=${onA.filePath}`);
assert.ok(onA.filePath.startsWith(h.runtime.paths.catalogSkills));
assert.equal(onA.blockedByAgentFilter, false);
const onB = (await report(b.runtimeAgentId)).skills.find((s) => s.name === "catalog-probe");
assert.equal(onB.blockedByAgentFilter, true);
// A turn on A: the prompt lists the skill and a read of its location returns the marker
// (tools.fs.workspaceOnly is on); a turn on B never lists it.
const turnA = await h.settle(await h.send(a, "read", ""));
assert.ok(JSON.stringify(h.model.requests.slice(turnA.from)).includes("catalog-probe"));
assert.ok(turnA.result.includes(marker));
const turnB = await h.settle(await h.send(b, "none", "true"));
assert.ok(!JSON.stringify(h.model.requests.slice(turnB.from)).includes("catalog-probe"));
// The running config carries the locked load section.
assert.deepEqual((await h.running()).skills.load.extraDirs, [h.runtime.paths.catalogSkills]);
```

`readTool(input)`: when the turn text contains `[cmd:read]`, return `{ name: "read", arguments: { path } }` where `path` is the `<location>` the system prompt lists for `catalog-probe` (parse it from `input.messages`). Use the exact `settle` result fields the helper returns; adapt the property names above to them.

- [ ] **Step 6: Run the contract against the pinned runtime**

Run: `AGENTPIER_SKILLS_CONTRACT_RUNTIME="$HOME/Library/Application Support/AgentPier/assistants/runtimes/<pinned>" node --test tests/integration/assistant-skill-catalog-contract.test.js` (or `node scripts/provision-assistant-contracts.mjs --data-dir <tmp> --env-file <file>` first; never the live data dir's Gateway).
Expected: PASS. **Stop-gate:** if the read fails under `workspaceOnly`, or B sees the skill, stop and report to the owner before any further task; record the diagnostic `source` value for Task 5.

- [ ] **Step 7: List the contract and commit**

Add the file to `scripts/assistant-contract-shards.json` `files` and `seconds` (start with the measured local seconds); run `node --test tests/unit/assistant-contract-shards.test.js` (PASS).

```bash
git add server/features/assistants/runtime-paths.js server/features/assistants/runtime-config.js server/features/assistants/openclaw-config/locked-core.js tests/helpers/assistant-shell-compiled.js tests/integration/assistant-skill-catalog-contract.test.js scripts/assistant-contract-shards.json tests/unit/openclaw-locked-core.test.js tests/unit/agent-skills.test.js
git commit -m "feat: scan the agent skill catalog root in the pinned runtime"
```

---

### Task 2: Catalog store — versions, digests, swap, verify and restore

**Files:**
- Modify: `server/features/extensions/skill-digest.js` (`modes` option)
- Create: `server/features/extensions/skill-files.js` (moved `writeFiles` from `extension-store.js:29-36`)
- Modify: `server/features/extensions/extension-store.js` (import it)
- Create: `server/features/skill-catalog/catalog-store.js`
- Test: `tests/unit/skill-catalog-store.test.js`

**Interfaces:**
- Produces: `skillDigest(dir, { modes = true } = {}) -> string` (unchanged default).
- Produces: `writeSkillFiles(target: string, files: [name, Buffer, mode][], { readOnly = false } = {})` — `readOnly` writes 0o400, or 0o500 when the mode has an execute bit.
- Produces: `class SkillCatalogStore({ root })` with
  - `liveRoot: string` (`<root>/skills`)
  - `list(): CatalogRecord[]`, `byId(id)`, `byName(name)`, `names(): Set<string>`
  - `write(pack: { name, description, files }, meta: { importKind, source?, origin?, scan, needsSettings }) -> CatalogRecord` (new or next version of the same name)
  - `remove(id) -> CatalogRecord`
  - `verify(names?: string[]) -> { restored: string[], damaged: string[] }` (all records when omitted)
  - `dropped(names: string[], bundled = new Set()) -> string[]` — catalog names that are bundled, `needsSettings` or `damaged`
  - `sweep()`
- `CatalogRecord = { id, name, description, version, digest, contentHash, executables: string[], importKind, source?: { url }, origin?, scan: { verdict, rules, overridden }, needsSettings, damaged?: true, installedAt, updatedAt }`

- [ ] **Step 1: Write the failing tests** (temp dir per test, `fs.mkdtempSync`)

```js
test("a new skill is stored once and copied live read-only", () => {
  const s = new SkillCatalogStore({ root });
  const r = s.write(pack("probe", "v1", { "run.sh": 0o700 }), meta());
  assert.equal(r.version, 1);
  assert.ok(fs.existsSync(path.join(root, "store/probe", r.digest, "SKILL.md")));
  assert.equal(fs.statSync(path.join(s.liveRoot, "probe/SKILL.md")).mode & 0o777, 0o400);
  assert.equal(fs.statSync(path.join(s.liveRoot, "probe/run.sh")).mode & 0o777, 0o500);
  assert.deepEqual(r.executables, ["run.sh"]);
});
test("the same name becomes the next version and the old one leaves the store", () => {
  const v1 = s.write(pack("probe", "v1"), meta()), v2 = s.write(pack("probe", "v2"), meta());
  assert.equal(v2.id, v1.id); assert.equal(v2.version, 2);
  assert.ok(!fs.existsSync(path.join(root, "store/probe", v1.digest)));
  assert.match(fs.readFileSync(path.join(s.liveRoot, "probe/SKILL.md"), "utf8"), /v2/);
  assert.deepEqual(fs.readdirSync(s.liveRoot), ["probe"]); // nothing else scanned
});
test("a failed swap leaves the old version live", () => {
  // make staging write fail (e.g. a pack with an unsafe path) and assert v1 content live,
  // record still version 1, staging empty after sweep()
});
test("verify restores an edited live copy from the store", () => {
  fs.chmodSync(file, 0o600); fs.writeFileSync(file, "tampered");
  assert.deepEqual(s.verify(["probe"]), { restored: ["probe"], damaged: [] });
  assert.match(fs.readFileSync(file, "utf8"), /v1/);
});
test("verify only re-applies modes after a 0600 restore", () => {
  // chmod every live and store file to 0o600 -> verify() => { restored: [], damaged: [] },
  // run.sh is 0o500 again in live and store
});
test("a damaged store copy removes the live copy and marks the record", () => {
  // tamper store and live -> verify(["probe"]).damaged === ["probe"], live folder gone,
  // byName("probe").damaged === true, dropped(["probe"]) deepEqual ["probe"]
});
test("dropped names bundled, needsSettings and damaged catalog skills only", () => {
  assert.deepEqual(s.dropped(["probe", "github", "envy"], new Set(["probe"])), ["envy", "probe"]);
});
test("sweep removes staging leftovers, unreferenced versions and unknown live folders", () => {});
test("remove deletes live, store and record", () => {});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/unit/skill-catalog-store.test.js`
Expected: FAIL ("Cannot find module …catalog-store.js").

- [ ] **Step 3: Implement**

`catalog.json` written with `writePrivate` (`server/lib/storage.js`). `write`: stage into `<root>/staging/<uuid>` with `writeSkillFiles(..., { readOnly: true })`, digest it (`modes: false`), `renameSync` staging → `store/<name>/<digest>` (identical digest: reuse), then copy store → `staging/<uuid2>`, rename live `skills/<name>` → `staging/<uuid>-old` (if any), rename `staging/<uuid2>` → `skills/<name>`, write the record, then remove the old live copy and the old store version. On any error before the record is written, move `-old` back and remove what was staged (pattern of `ExtensionsStore.replaceSkill`). `verify` compares `skillDigest(live, { modes: false })` with `record.digest`, re-copies from store on mismatch (store copy digest-checked first), then chmods files from `executables`. Every path joined below `root` goes through `safePath` (`server/features/extensions/mcp-config.js`).

- [ ] **Step 4: Run the new tests and the extension regressions**

Run: `node --test tests/unit/skill-catalog-store.test.js tests/integration/skill-import-scan.test.js tests/integration/mcp-package-skills.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/extensions/skill-digest.js server/features/extensions/skill-files.js server/features/extensions/extension-store.js server/features/skill-catalog/catalog-store.js tests/unit/skill-catalog-store.test.js
git commit -m "feat: store agent catalog skills with versions and digests"
```

---

### Task 3: Install and update flow — preview, clash refusal, re-confirm on a worse scan

**Files:**
- Modify: `server/features/extensions/skill-packages.js` (add `readSkillPack`, `skillRequirements`)
- Modify: `server/features/extensions/extension-store.js:298-333` (`readPack` delegates)
- Modify: `server/features/extensions/skill-previews.js` (`create` extra, `take` accepted rules)
- Create: `server/features/skill-catalog/catalog-service.js`
- Modify: `server/lib/i18n/de/extensions.js`, `server/lib/i18n/en/extensions.js`, `server/lib/i18n/translation-lock.json`
- Test: `tests/integration/skill-catalog-install.test.js`, `tests/unit/skill-previews.test.js`

**Interfaces:**
- Consumes: `SkillCatalogStore` (Task 2).
- Produces: `readSkillPack(input, { fetchImpl, signal }) -> Promise<pack>` (the body of `ExtensionsStore.readPack`; `pack.source = { url }` for every GitHub input); `skillRequirements(buffer) -> { needsSettings: boolean }` (frontmatter `metadata.openclaw.requires.env/config` or `primaryEnv`).
- Produces: `SkillPreviews.create(accountId, pack, importKind, extra = {})` (extra merged into the entry and into `publicPreview`); `take(accountId, input, { acceptedRules = [] } = {})` — a `warn` verdict whose rules are all in `acceptedRules` needs no `acceptWarnings`; `block` always needs the override.
- Produces: `class SkillCatalog({ store, bundledNames: () => Set, globalNames: () => Set, reportNames: () => Promise<Set|null>, fetchImpl })` with
  - `preview(input) -> Promise<Preview & { replaces?: { id, version }, newRules: string[] }>`
  - `install(input) -> Promise<{ skill: CatalogRecord, scan: { verdict, rules, findings, importKind, overridden }, replaced: boolean }>`
  - `checkUpdate(id) -> Promise<{ upToDate: true } | Preview>`
  - `close()`
  - writes serialized through one promise queue.
- Server message keys (both languages, `extensions.*`): `catalogNameBundled`, `catalogNameTaken`, `catalogSkillNotFound`, `catalogUpdateNeedsRepository`.

- [ ] **Step 1: Write the failing tests** (`tests/integration/skill-catalog-install.test.js`, fixtures from `tests/fixtures/skill-scan-cases.js`, a fake `fetchImpl` like `tests/integration/skill-github-refs.test.js`)

```js
test("SKILL.md, zip and GitHub sources install into the catalog", async () => {
  for (const input of [skillMd("one"), zip("two"), github("three")]) {
    const p = await c.preview(input);
    await c.install({ previewId: p.previewId, contentHash: p.contentHash, acceptWarnings: p.verdict === "warn" });
  }
  assert.deepEqual([...c.store.names()].sort(), ["one", "three", "two"]);
  assert.equal(c.store.byName("three").source.url, githubUrl("three"));
  assert.equal(c.store.byName("three").origin.commit, commit);
});
test("a bundled, plugin or global skill name is refused at preview", async () => {
  await assert.rejects(c.preview(skillMd("github")), { status: 409 }); // bundledNames has github
  await assert.rejects(c.preview(skillMd("browser-automation")), { status: 409 }); // globalNames
});
test("the same name previews as an update and replaces it on confirm", async () => {
  const p = await c.preview(skillMd("one", "v2"));
  assert.deepEqual(p.replaces, { id: c.store.byName("one").id, version: 1 });
  const done = await c.install({ previewId: p.previewId, contentHash: p.contentHash });
  assert.equal(done.replaced, true); assert.equal(done.skill.version, 2);
});
test("an update with a new warning rule needs confirmation, a known one does not", async () => {
  // v1 installed with accepted "encoded-blob"; v2 adds "prompt-injection":
  // install without acceptWarnings -> 409 skillWarningsNotAccepted; p.newRules === ["prompt-injection"]
  // v3 with only "encoded-blob" -> installs without acceptWarnings
});
test("a blocked update needs the override naming every blocking rule", async () => {});
test("check for update: unchanged digest says up to date, a moved branch previews", async () => {
  assert.deepEqual(await c.checkUpdate(id), { upToDate: true });
  moveBranch(); const p = await c.checkUpdate(id);
  assert.equal(p.replaces.id, id);
});
test("check for update refuses an uploaded skill", async () => {
  await assert.rejects(c.checkUpdate(uploadedId), { status: 400 });
});
test("needsSettings comes from the frontmatter", async () => {
  // metadata: { openclaw: { primaryEnv: "GEMINI_API_KEY" } } -> record.needsSettings === true
});
```

Add to `tests/unit/skill-previews.test.js`: `take(..., { acceptedRules: ["encoded-blob"] })` passes a warn preview with only that rule; a block still throws `skillScanBlocked`.

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/integration/skill-catalog-install.test.js tests/unit/skill-previews.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** `readSkillPack` (move, not copy, the body of `ExtensionsStore.readPack`; the store keeps its abort map by wrapping the promise), the `SkillPreviews` options, and `SkillCatalog`. The catalog uses account id `"catalog"` for its previews. Clash order: bundled → global → Gateway report (a non-catalog `source` for that name). `checkUpdate` re-runs `readSkillPack({ url: record.source.url })` and compares `contentHash` with the record.

- [ ] **Step 4: Run the tests and the CLI skill regressions**

Run: `node --test tests/integration/skill-catalog-install.test.js tests/unit/skill-previews.test.js tests/integration/skill-import-scan.test.js tests/integration/skill-github-refs.test.js tests/blackbox/skill-import-audit.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm translations and commit**

Run: `npm run i18n:confirm -- extensions.catalog` (review each de/en pair first).

```bash
git add server/features/extensions/skill-packages.js server/features/extensions/extension-store.js server/features/extensions/skill-previews.js server/features/skill-catalog/catalog-service.js server/lib/i18n tests/integration/skill-catalog-install.test.js tests/unit/skill-previews.test.js
git commit -m "feat: install and update agent catalog skills through the scanned preview"
```

---

### Task 4: Catalog routes, wiring and audit

**Files:**
- Create: `server/http/routes/agent-skill-catalog.js`
- Modify: `server/http/routes/assistants.js:122` (`router.use(agentSkillCatalogRoutes(services))`)
- Create: `server/application/skill-catalog-wiring.js`
- Modify: `server/application/assistants.js:18-55` (`assistantSkillCatalog` in `assistantServiceNames`; connect after `connectAgentSecrets`)
- Modify: `server/features/audit/audit-schema.js:240-252` (`"catalog-skill"` kind)
- Test: `tests/blackbox/agent-skill-catalog-routes.test.js`

**Interfaces:**
- Consumes: `SkillCatalog` (Task 3), `bundledSkillNames` (`agent-skills.js`), `shadowingSkillNames` (`skill-shadows.js`).
- Produces: `connectSkillCatalog(graph) -> SkillCatalog` which creates the store on `graph.assistantRuntime.paths.skillCatalog`, runs `sweep()`, and sets `graph.assistants.skills.catalog`, `graph.configuration.skillCatalog` (via `graph.assistants.config`) and `graph.assistantRuntime.skillCatalog` to the store; chains `assistantRuntime.beforeSpawn` with `store.verify()` first.
- Routes (owner only by `route-access.js` deny-by-default):
  - `GET /api/agent-skill-catalog` → `{ skills: CatalogView[] }` (Task 5 fills `requirements`, `agents`, `state`)
  - `POST /api/agent-skill-catalog/skills/preview` → preview
  - `POST /api/agent-skill-catalog/skills` → 201 `{ skill, replaced }`
  - `POST /api/agent-skill-catalog/skills/:skillId/check` → `{ upToDate: true }` or preview
  - `DELETE /api/agent-skill-catalog/skills/:skillId` → `{ removed, switchedOff }` (Task 5)
- Audit: `extension.installed` / `extension.overridden` (new skill), `extension.updated` (new version), `extension.deleted` (removal); `resourceType: "extension"`, `resourceId: record.id`, `details: { kind: "catalog-skill", verdict, importKind, scanRules, count }` (`count` = findings, or switched-off agents on removal).

- [ ] **Step 1: Write the failing blackbox test** (pattern of `tests/blackbox/skill-import-audit.test.js` and `tests/blackbox/assistant-skill-routes.test.js`)

```js
test("the owner installs, updates and removes a catalog skill, audited by id", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const p = await (await f.request("/api/agent-skill-catalog/skills/preview", post(skillMd("probe")))).json();
  const res = await f.request("/api/agent-skill-catalog/skills", post({ previewId: p.previewId, contentHash: p.contentHash }));
  assert.equal(res.status, 201);
  const { skills } = await (await f.request("/api/agent-skill-catalog")).json();
  assert.deepEqual(skills.map((s) => s.name), ["probe"]);
  const events = f.audit.events.filter((e) => e.details?.kind === "catalog-skill");
  assert.deepEqual(events.map((e) => e.action), ["extension.installed"]);
  assert.ok(!JSON.stringify(events).includes("probe"));
});
test("a restricted user never reaches the catalog", async (t) => {
  // signedInUser(f): GET /api/agent-skill-catalog and POST .../skills/preview -> 404
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test tests/blackbox/agent-skill-catalog-routes.test.js`
Expected: FAIL (404 for the owner).

- [ ] **Step 3: Implement** routes, wiring and the audit kind. The audit append follows `auditSkillDecision` in `server/http/routes/extensions.js` (a failing append is logged, never an error).

- [ ] **Step 4: Run the test and the route guards**

Run: `node --test tests/blackbox/agent-skill-catalog-routes.test.js tests/blackbox/user-route-denial.test.js tests/integration/route-inventory.test.js tests/integration/owner-content-classification.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/http/routes/agent-skill-catalog.js server/http/routes/assistants.js server/application/skill-catalog-wiring.js server/application/assistants.js server/features/audit/audit-schema.js tests/blackbox/agent-skill-catalog-routes.test.js
git commit -m "feat: serve the agent skill catalog to the owner"
```

---

### Task 5: Agent skill list and check accept catalog skills; removal switches off everywhere

**Files:**
- Modify: `server/features/assistants/agent-skills.js` (header comment, `skillCatalog`, `AgentSkills.list/check`)
- Create: `server/features/assistants/catalog-switches.js`
- Modify: `server/http/routes/agent-skill-catalog.js` (DELETE, `agents` and `requirements` in GET)
- Test: `tests/unit/agent-skills-catalog.test.js`, `tests/integration/skill-catalog-switches.test.js`

**Interfaces:**
- Consumes: `SkillCatalogStore.list()/liveRoot/dropped` (Task 2).
- Produces: `export const catalogSource = "<value from Task 1>"` in `agent-skills.js`.
- Produces: `skillCatalog({ report, bundled, assistant, roots, shadowed, fallback, catalog = [], liveRoot })` — each item may now carry `source: "catalog"`, `version`, and the new states `"needsSettings"` and `"damaged"`. Rules:
  - a catalog name whose report entry has `source === catalogSource` and `filePath` inside `liveRoot` → sanitized entry, `source: "catalog"`, state `needsSettings` when the record says so or the entry has `requirements.env`/`requirements.config`/`primaryEnv`;
  - a catalog name the runtime bundles, or whose report entry has another source → `state: "shadowed"`, `source: "catalog"`;
  - a damaged record → `state: "damaged"`; a catalog name absent from the report → `"unavailable"`;
  - `fallback` keeps catalog-source entries too (they are not agent-specific).
- Produces: `AgentSkills.check` refuses an added name whose state is `shadowed`, `unavailable`, `needsSettings` or `damaged` (409 `skillUnavailable`).
- Produces: `catalogUsers(assistants, name) -> { id, name }[]` (eligible agents whose stored list holds `name`) and `switchOffEverywhere(assistants, name) -> Promise<string[]>` (agent ids changed; `store.updateAssistant` with one retry on 409, then `config.apply(id)` under `assistants.admit` when `runtime.client?.ready`, failures left pending).
- GET catalog view per record: `{ id, name, description, version, importKind, origin?, repository: boolean, scan, needsSettings, state: "ready"|"shadowed"|"damaged"|"needsSettings", requirements?: { bins, anyBins }, agents: { id, name }[] }`.

- [ ] **Step 1: Write the failing unit tests** (`tests/unit/agent-skills-catalog.test.js`, reuse the `status()` builder shape of `tests/unit/agent-skills.test.js`)

```js
const live = `${host}/skill-catalog/skills`;
const extra = (name, extra = {}) => status(name, { source: catalogSource, bundled: false,
  filePath: `${live}/${name}/SKILL.md`, baseDir: `${live}/${name}`, ...extra });
test("a catalog skill is listed next to bundled ones without paths", () => {
  const { skills } = skillCatalog({ report: { skills: [status("github"), extra("probe")] },
    bundled: new Set(["github"]), assistant: agent({ skills: ["probe"] }), roots: [host],
    catalog: [{ name: "probe", version: 2 }], liveRoot: live });
  const probe = skills.find((s) => s.name === "probe");
  assert.equal(probe.source, "catalog"); assert.equal(probe.version, 2);
  assert.equal(probe.state, "ready"); assert.ok(!JSON.stringify(skills).includes(host));
});
test("a catalog name the runtime bundles is shadowed", () => {});
test("a non-catalog skill of a catalog name, or one outside the root, is shadowed", () => {});
test("needsSettings from the record or the report's env, config or primaryEnv", () => {});
test("a damaged record is damaged; a missing report entry is unavailable", () => {});
test("the fallback report keeps catalog entries", () => {});
```

`tests/integration/skill-catalog-switches.test.js` (with `shellService` and `skillGateway` of `tests/integration/assistant-skills.test.js`, the report double returning catalog entries):

```js
test("a catalog skill switches on live for one agent", async (t) => {
  await save(f, home, ["probe"]);
  assert.deepEqual(f.client.effective().agents.entries[home.runtimeAgentId].skills, ["probe"]);
});
test("needsSettings, damaged and shadowed catalog skills are refused when added", async () => {
  await assert.rejects(save(f, home, ["envy"]), { status: 409 });
});
test("removing a catalog skill switches it off on every agent and lists them first", async () => {
  assert.deepEqual(catalogUsers(f.service, "probe").map((a) => a.id).sort(), [a.id, b.id].sort());
  assert.deepEqual((await switchOffEverywhere(f.service, "probe")).sort(), [a.id, b.id].sort());
  assert.deepEqual(f.store.getAssistant(a.id).skills, []);
  assert.equal(f.client.effective().agents.entries[a.runtimeAgentId].skills, undefined);
});
test("the owner switches a catalog skill on a shared user agent; the hard lock holds", async () => {
  // user agent from tests/helpers/users.js: entry.skills ["probe"], tools.deny lists lockedTools, no tools.exec
});
test("a temporary member inherits its lead's catalog skill", async () => {
  // lead with ["probe"], temporary member with grant skills "all" -> member entry.skills ["probe"]
});
test("a user's settings patch with skills is refused", async () => {
  // patchFor(...) from user-agent-settings.js with { skills: ["probe"] } -> 400
});
```

(The live-apply test passes only after Task 6; write it here, mark it `{ todo: "Task 6" }`, and remove the `todo` in Task 6.)

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/unit/agent-skills-catalog.test.js tests/integration/skill-catalog-switches.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** the listing rules, the check, `catalog-switches.js`, and the route's DELETE (call `switchOffEverywhere` before `catalog.remove`) and GET view (`requirements` from `runtime.client.call("skills.status", {})` when ready, matched by name and `catalogSource`). Update the header comment of `agent-skills.js` ("only bundled skills are assignable" → bundled and catalog skills).

- [ ] **Step 4: Run the new and the existing skill tests**

Run: `node --test tests/unit/agent-skills-catalog.test.js tests/integration/skill-catalog-switches.test.js tests/unit/agent-skills.test.js tests/integration/assistant-skills.test.js tests/blackbox/assistant-skill-routes.test.js`
Expected: PASS (the `todo` test reported as todo).

- [ ] **Step 5: Commit**

```bash
git add server/features/assistants/agent-skills.js server/features/assistants/catalog-switches.js server/http/routes/agent-skill-catalog.js tests/unit/agent-skills-catalog.test.js tests/integration/skill-catalog-switches.test.js
git commit -m "feat: list and switch catalog skills per agent"
```

---

### Task 6: Compile and live apply — catalog names, shadowing, digest check before every turn

**Files:**
- Modify: `server/features/assistants/assistant-config.js:78-107, 196-205` (`verifySkills`, `expectedSkills`, `applyOnce`)
- Modify: `server/features/assistants/runtime-supervisor.js:306-313` (start compile drops)
- Modify: `server/features/assistants/openclaw-config/skill-shadows.js:17-27` (workshop root, assistant argument)
- Modify: `server/features/assistants/openclaw-config/agent-entry.js:35-63` (comments: bundled and catalog skills)
- Modify: `server/features/assistants/runtime-config.js:313-316` (comment)
- Modify: `tests/integration/assistant-skill-catalog-contract.test.js` (live apply, update, tamper)
- Test: `tests/integration/skill-catalog-switches.test.js` (drop `todo`), `tests/unit/agent-skills.test.js` (shadow roots)

**Interfaces:**
- Consumes: `catalogSource` (Task 5), `SkillCatalogStore.names()/liveRoot/verify()/dropped()` (Task 2), `this.skillCatalog` set by Task 4.
- Produces: `AssistantConfig.verifySkills(assistant, names)` keeps a catalog name only when the report entry has `source === catalogSource` and `filePath` inside `skillCatalog.liveRoot`; any other name only when `source === "openclaw-bundled"` (unchanged).
- Produces: `applyOnce` runs `this.skillCatalog?.verify(assigned)` before the fingerprint and adds `skillCatalog.dropped(assigned)` to `shadowed` (both branches, so the shortcut path also verifies).
- Produces: the start compile's `skillShadows[runtimeAgentId]` = `shadowedSkills(...)` ∪ `skillCatalog.dropped(personalSkills(profile), bundledSkillNames(runtime.entryPath))`.
- Produces: `skillShadowRoots(root, assistant)` (now the assistant, not its id) adding `path.join(root, "state", "agents", assistant.runtimeAgentId, "agent", "workshop-skills")`; update both callers (`shadowedSkills`, `AgentSkills.list`).

- [ ] **Step 1: Write the failing tests**

In `tests/integration/skill-catalog-switches.test.js` remove `todo` from the live-apply test and add:

```js
test("a tampered catalog copy is restored before the agent's next turn", async () => {
  fs.chmodSync(file, 0o600); fs.writeFileSync(file, "planted");
  await f.config.apply(home.id);
  assert.match(fs.readFileSync(file, "utf8"), /v1/);
});
test("a catalog name the Gateway resolves to the bundled skill is never compiled", async () => {
  // report entry for "probe" with source "openclaw-bundled" -> entry.skills undefined
});
test("a workshop skill of the same name shadows a catalog skill", async () => {
  // write state/agents/<runtimeAgentId>/agent/workshop-skills/probe/SKILL.md -> entry.skills undefined
});
```

In `tests/unit/agent-skills.test.js`: `skillShadowRoots(root, { id: "a", runtimeAgentId: "ap-a" })` includes `${root}/state/agents/ap-a/agent/workshop-skills`.

Extend the contract (Task 1 file) with: live apply of `["catalog-probe"]` on B through `h.assistants.update` (entry gets the list; next turn lists it), an update via `SkillCatalogStore.write` with a new marker (A's next turn reads the new marker, `h.runtime.generation` unchanged), and a tamper of A's live `SKILL.md` restored before A's next turn.

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/integration/skill-catalog-switches.test.js tests/unit/agent-skills.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** the changes listed in Interfaces. Keep `assistant-config.js` under 600 lines (486 now).

- [ ] **Step 4: Run unit, integration and the native contract**

Run: `node --test tests/integration/skill-catalog-switches.test.js tests/unit/agent-skills.test.js tests/unit/openclaw-agent-entry.test.js tests/integration/assistant-skills.test.js`
Expected: PASS.
Run: `AGENTPIER_SKILLS_CONTRACT_RUNTIME=<runtime> node --test tests/integration/assistant-skill-catalog-contract.test.js tests/integration/assistant-skills-contract.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/assistants/assistant-config.js server/features/assistants/runtime-supervisor.js server/features/assistants/openclaw-config tests/integration/skill-catalog-switches.test.js tests/unit/agent-skills.test.js tests/integration/assistant-skill-catalog-contract.test.js
git commit -m "feat: compile catalog skills and restore tampered copies before each turn"
```

---

### Task 7: Agent › Skills shows catalog skills, limits and settings needs

**Files:**
- Modify: `web/features/assistants/settings/skill-list.js` (`skillLocked`, `statusText`, filter)
- Modify: `web/features/assistants/settings/SkillsPage.jsx:13-37` (`SkillDetails`)
- Modify: `web/features/assistants/settings/SkillsGroup.jsx` (row label)
- Modify: `web/lib/i18n/{de,en}/assistant-skills.js`, `web/lib/i18n/translation-lock.json`
- Test: `tests/unit/agent-skill-list.test.js`, `tests/browser/assistant-skills.spec.js`

**Interfaces:**
- Consumes: the list item shape of Task 5 (`source`, `version`, states `needsSettings`, `damaged`).
- Produces: `skillLocked(skill, on)` true when off and state in `["shadowed", "unavailable", "needsSettings", "damaged"]`; `skillFilters` gains `"catalog"` (items with `source === "catalog"`).
- Copy (en; de alongside): `row: "Skills"`; `intro` and `pageHint` name both bundled and catalog skills and link the catalog (**Agents › Skills**); `fromCatalog: (version) => \`From the skill catalog · version ${version}\``; `worksWithLimits: "Works with limits: it runs programs and this agent has no shell access."`; `states.needsSettings: "Needs settings — not supported yet"`; `states.damaged: "Damaged — install it again in Agents › Skills"`; `states.shadowedCatalog: "Off: a bundled skill of the same name replaces this catalog skill. Remove one of them to use the other."`; `filters.catalog: "From the catalog"`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/agent-skill-list.test.js
test("catalog skills that need settings or are damaged cannot be switched on", () => {
  assert.equal(skillLocked({ state: "needsSettings" }, false), true);
  assert.equal(skillLocked({ state: "damaged" }, true), false);
});
test("the catalog filter keeps catalog skills only", () => {
  assert.deepEqual(visibleSkills([{ name: "a", source: "catalog" }, { name: "b" }],
    { filter: "catalog" }).map((s) => s.name), ["a"]);
});
```

`tests/browser/assistant-skills.spec.js`: add a catalog item (`source: "catalog"`, `usesShell: true`, shell `off`) and one `needsSettings` item to the mocked `GET /api/assistants/:id/skills`; in English expect "From the skill catalog · version 2", "Works with limits…", the `needsSettings` switch disabled, and saving sends the catalog name in the PATCH `skills`.

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/unit/agent-skill-list.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**; the "Works with limits" line replaces "Needs shell access" for catalog items only; `SkillsGroup` shows the new row label.

- [ ] **Step 4: Verify**

Run: `node --test tests/unit/agent-skill-list.test.js tests/unit/ui-guide-rules.test.js`
Expected: PASS.
Run: `npm run build && npx playwright test tests/browser/assistant-skills.spec.js`
Expected: PASS.

- [ ] **Step 5: Confirm translations and commit**

Run: `npm run i18n:confirm -- assistant-skills`

```bash
git add web/features/assistants/settings web/lib/i18n tests/unit/agent-skill-list.test.js tests/browser/assistant-skills.spec.js
git commit -m "feat: show catalog skills with their limits on the agent's Skills page"
```

---

### Task 8: Agents › Skills catalog page — install, update, remove

**Files:**
- Modify: `web/features/assistants/hub-routes.js:2` (`"skills"` tab)
- Modify: `web/features/assistants/hub/AgentsHub.jsx` (render the tab)
- Create: `web/features/assistants/hub/SkillCatalogTab.jsx`
- Create: `web/features/assistants/hub/useSkillCatalog.js`
- Modify: `web/features/extensions/SkillInstallForm.jsx` (props `destination`, `paths`, `title`, `installLabel`; defaults keep today's behaviour)
- Modify: `web/features/extensions/SkillScanPreview.jsx` (show `replaces` and `newRules` when present)
- Modify: `web/features/assistants/assistant-api.js` (catalog calls)
- Create: `web/lib/i18n/{de,en}/agent-skill-catalog.js`, `web/lib/i18n/messages/agent-skill-catalog.js`
- Modify: `web/lib/i18n/{de,en}/agents-hub.js` (`tabs.skills`), `web/lib/i18n/{de,en}/skill-scan.js`, `web/lib/i18n/translation-lock.json`
- Test: `tests/unit/agents-hub.test.js`, `tests/browser/agent-skill-catalog.spec.js`

**Interfaces:**
- Consumes: the routes of Task 4 and the view of Task 5.
- Produces: `assistantApi.skillCatalog()`, `.checkCatalogSkill(id)`, `.removeCatalogSkill(id)`; install goes through `SkillInstallForm` with `paths = { preview: "/api/agent-skill-catalog/skills/preview", install: "/api/agent-skill-catalog/skills" }` and `destination` = the translated "Skill catalog for all agents" (no host path).
- Page: `ListCard` of catalog skills; each `ListRow` shows description, "Version N · from upload|GitHub <repo> @ <ref> (<short commit>)", scan verdict (`StatusChip`), "Runs programs: gh, jq" or "Shown once the agent service runs", "Needs settings — not supported yet", "Shadowed by a bundled skill" or "Damaged — install it again", "On for N agents". Row actions: **Check for update** (GitHub only; "Up to date" notice or the preview panel), **Upload new version** (opens the install form), **Remove** (`ConfirmDialog` naming the agents using it: "Removing it switches it off for: Home, Ana's helper.").

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/agents-hub.test.js
test("the skills tab is a hub tab", () => {
  assert.deepEqual(read("/agents?tab=skills"), { agentsTab: "skills" });
  assert.equal(agentsHubQuery({ agentsTab: "skills" }), "?tab=skills");
});
```

`tests/browser/agent-skill-catalog.spec.js` (English, routes mocked like `tests/browser/skill-import-scan.spec.js`): open `/agents?tab=skills`; install a SKILL.md through preview → confirm → row "probe" listed; a same-name upload shows "Replaces version 1" and a new warning needs the checkbox; **Check for update** on a GitHub skill shows "Up to date"; **Remove** shows the confirm naming "Home" and sends DELETE. Then on `/agents/home/settings/capabilities/skills` switch the catalog skill on and save (PATCH `skills` contains `probe`).

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/unit/agents-hub.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement.** Keep `SkillInstallForm.jsx` under 600 lines and its existing caller (`web/features/extensions/useProfileExtensions.js` / `SkillsTab`) unchanged in behaviour.

- [ ] **Step 4: Verify**

Run: `node --test tests/unit/agents-hub.test.js tests/unit/ui-guide-rules.test.js` and the i18n parity tests (`node --test tests/unit/i18n-*.test.js`)
Expected: PASS.
Run: `npm run build && npx playwright test tests/browser/agent-skill-catalog.spec.js tests/browser/skill-import-scan.spec.js`
Expected: PASS.

- [ ] **Step 5: Confirm translations and commit**

Run: `npm run i18n:confirm -- agent-skill-catalog agents-hub skill-scan`

```bash
git add web tests/unit/agents-hub.test.js tests/browser/agent-skill-catalog.spec.js
git commit -m "feat: manage the agent skill catalog under Agents › Skills"
```

---

### Task 9: Backups carry the catalog intact

**Files:**
- Modify: `server/features/operations/assistant-backup.js:83-134` (`skill-catalog/` exempt from `volatileTree`/`legacyVolatileTree`, like `workspaces/`; `staging/` excluded)
- Modify: `docs/backups.md:24-35`
- Test: `tests/integration/skill-catalog-backup.test.js`

**Interfaces:**
- Consumes: `SkillCatalogStore` (Task 2); backup/restore helpers used by the existing assistant backup tests (`tests/integration/*assistant-backup*.test.js`).
- Produces: `assistants/skill-catalog/{catalog.json,store/**,skills/**}` are public configuration members of every host backup; `assistants/skill-catalog/staging/**` never is.

- [ ] **Step 1: Write the failing test**

```js
test("a backup carries the catalog, and the restore verifies without damage", async (t) => {
  // store.write(pack("redis-cache", "v1", { "node_modules/x/run.sh": 0o700 }), meta())
  // capture a backup without history/credentials; members include
  //   assistants/skill-catalog/catalog.json, .../store/redis-cache/<digest>/SKILL.md,
  //   .../skills/redis-cache/node_modules/x/run.sh; none under .../staging/
  // restore into a fresh data dir -> new SkillCatalogStore(...).verify() deepEqual
  //   { restored: [], damaged: [] }; run.sh mode 0o500 again
  // the agent's stored skills list (assistants.sqlite) still holds "redis-cache"
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test tests/integration/skill-catalog-backup.test.js`
Expected: FAIL (the cache-named folder is missing from the archive).

- [ ] **Step 3: Implement** the exemption and the exclusion; update `docs/backups.md` (catalog listed under agent configuration; switches are part of each agent's settings).

- [ ] **Step 4: Run the backup suites**

Run: `node --test tests/integration/skill-catalog-backup.test.js` and `npm run test:integration -- --test-name-pattern=backup` (or the backup test files directly)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/operations/assistant-backup.js docs/backups.md tests/integration/skill-catalog-backup.test.js
git commit -m "feat: back up the agent skill catalog"
```

---

### Task 10: Documentation and final check

**Files:**
- Modify: `docs/agents.md` (agents page tabs list `:57-73`, Capabilities › Skills `:253-261`, Users `:1313+`)
- Modify: `docs/assistant-gateway.md` (`## Skills` at `:3932`: catalog root, locked `skills.load`, precedence, digest restore, the shell gap stated like the existing shell notes)
- Modify: `docs/users.md` (owner switches catalog skills on users' agents, including shared ones; users never switch skills)
- Modify: `docs/shared-cli-extensions.md` (`### Skill import scan`: the same scan guards agent catalog installs; CLIs keep per-profile skills)
- Modify: `README.md`, `README.de.md` (feature line)
- Delete: `docs/superpowers/specs/2026-10-27-agent-skill-catalog-design.md`, `docs/superpowers/plans/2026-10-27-agent-skill-catalog.md` (before the pull request)

- [ ] **Step 1: Update the docs** with the exact UI labels from Tasks 7–8 (**Agents › Skills**, **Agent › Skills**, **Check for update**, **Upload new version**, **Remove**, "Works with limits", "Needs settings — not supported yet").

- [ ] **Step 2: Run the full check**

Run: `npm run check`
Expected: lint, format, structure (every file ≤ 600 lines), build and backend tests pass. Known environment-only failure: `shell.test.js` (see project memory); confirm it fails identically on `main`.

- [ ] **Step 3: Commit the docs**

```bash
git add docs README.md README.de.md
git commit -m "chore: document the agent skill catalog"
```

- [ ] **Step 4: Remove the working documents before opening the pull request**

```bash
git rm docs/superpowers/specs/2026-10-27-agent-skill-catalog-design.md docs/superpowers/plans/2026-10-27-agent-skill-catalog.md
git commit -m "chore: remove the agent skill catalog working documents"
```
