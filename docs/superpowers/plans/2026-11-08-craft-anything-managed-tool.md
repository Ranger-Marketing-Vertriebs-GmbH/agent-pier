# Craft Anything as a managed tool (PR 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install Craft Anything with one click like REA, give sessions its analysis tools as a managed MCP server that can never start a rebuild, and share Ghidra/JDK with REA.

**Architecture:** A `CraftTool` beside `ReaTool` (`server/features/tools/`). The binary is a downloaded, checksum-verified component placed with the existing component installer (`rea-components.js`) under `<dataDir>/clis/craft-anything`. The MCP row is a managed stdio row (`managed: { tool: "craft-anything" }`) with a literal command, created through `CentralMcpChanges#create`. Ghidra/JDK stay the existing `rea-ghidra`/`rea-jdk` components (ids unchanged: renaming would move the paths installed REA rows hold in `GHIDRA_INSTALL_DIR`); each tool keeps them while the other wants them.

**Tech Stack:** Node.js ES modules, Express, React/JSX, `smol-toml`, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-08-craft-anything-design.md` (decisions 1–3). PR 2 (rebuild supervisor, Craft area, projects, start tool) gets its own plan after this merges.

## Global Constraints

- AGENTS.md in full: Prettier style, files ≤ 600 lines (`check:structure`), UI only from `docs/ui-guide.md` components/tokens, no hex colours outside `web/styles/base.css`, no font below 11px, breakpoints only from `web/lib/breakpoints.js`, no bespoke dialogs/menus/switches.
- Every UI string in `web/lib/i18n/de/` and `en/` with matching keys and arguments, imported from `web/lib/i18n/messages/`; server strings in `server/lib/i18n/de|en`; run `npm run i18n:confirm` and commit both `translation-lock.json` files.
- Live updates over the live channel (`useLiveTopic`), no client polling; document the topic in `docs/architecture.md` (Live channel).
- New user-facing action → ⌘K entry in `web/app/search-entries.js` with German and English labels; extend `tests/unit/search-index.test.js`.
- Pinned release: Craft Anything **0.5.0**. Assets (SHA-256 from the release's `SHA256SUMS.txt`, re-hashed on download 2026-11-08):
  - darwin (arm64 and x64): `https://github.com/storytold/craft-anything/releases/download/v0.5.0/craft-anything-cli-0.5.0-macos-universal.zip`, sha256 `88ce25c2d727e8536678a4c9877e1a8020165198869135f08e7fac13761835fc`, size `26956827`, kind `zip`, top `craft-anything-cli-0.5.0-macos-universal`, binary `craft-anything-cli` (at the top), installedSize `65560576`.
  - linux-x64: `…/v0.5.0/craft-anything-0.5.0-linux-x86_64.tar.gz`, sha256 `d18c54ef05e5c7ef50f8c4959fee8983c0a4a1f141edc488d11f7029973c885b`, size `68980627`, kind `tar.gz`, top `craft-anything-0.5.0-linux-x86_64`, binary `bin/craft-anything-cli`, installedSize `34758656` (after removing the GUI binary).
  - linux-arm64: `…/v0.5.0/craft-anything-0.5.0-linux-aarch64.tar.gz`, sha256 `5fbbf8de469e9ec07355c5a5686412ac4775ed341a4f2a09d7ff61ff53c15805`, size `65813141`, kind `tar.gz`, top `craft-anything-0.5.0-linux-aarch64`, binary `bin/craft-anything-cli`, installedSize `28803072` (after removing the GUI binary).
  - Linux tarballs also hold the GUI binary `bin/craft-anything`; remove it after unpacking (not needed, ~100 MB).
- The session row always runs `craft-anything-cli mcp --restricted --allow-web --allow-capture` plus `--clean-room` (default) or `--deep` (owner's choice in the dialog). `--restricted` refuses every consent-gated, machine-acting or network tool — `rebuild_start`, `rebuild_question_ask`, run/frida/adb tools — before Craft Anything reads its settings, so an agent's `settings_set ask_before_running false` cannot lift it.
- The row's environment: `CRAFT_ANYTHING_CONFIG_DIR=<dataDir>/craft-anything/sessions`, `CRAFT_ANYTHING_NO_KEYCHAIN=1`; both are locked env keys of the managed row.
- AgentPier writes `<dataDir>/craft-anything/sessions/config.toml` on every apply, update and server start, keeping Craft Anything's other keys: `auto_mode = false`, `deep_mode = false`, `[engines.ghidra] install_dir` and `java_home`. With the shared Ghidra installed they point at its install dir and JDK home; without it `install_dir` is the stub launcher `<dataDir>/craft-anything/no-ghidra` (an executable `/bin/sh` script that prints `Ghidra is not installed. Install it in AgentPier: CLIs and extensions › Installation › Craft Anything.` to stderr and exits 1) and `java_home` is removed. Reason: with no `install_dir` Craft Anything searches `$HOME` (and on macOS `~/Desktop`, `~/Downloads`) and hung for minutes in the spike.
- Owner only, like REA. Tests never use a real Claude account, real downloads or the owner's folders.

## Review Focus

1. **REA already installed Ghidra** → installing Craft Anything with Ghidra reuses it, no second download (Task 3 test `reuses REA's Ghidra and JDK`).
2. **Removing REA while Craft Anything wants Ghidra** (and the reverse) → Ghidra/JDK stay; they go only when neither wants them (Task 4 tests).
3. **An agent flips settings** (`settings_set deep_mode true`, `ask_before_running false`) → the next server start rewrites AgentPier's keys and the row's args still say `--restricted --clean-room` (Task 2 test `rewrite keeps foreign keys and resets ours`, Task 3 test `row args`).
4. **A server stop mid-download** → the start sweep removes Craft Anything's unpublished folders like REA's (Task 1 test `sweep removes an unpublished craft-anything version`).
5. **Hosts without a Ghidra pin** (Intel Mac, Linux arm64) → Craft Anything installs, the Ghidra row is disabled with REA's reason, config uses the stub (Task 3 test `linux-arm64 installs without Ghidra`).

---

### Task 1: Pinned download of the Craft Anything binary

**Files:**

- Create: `server/features/tools/craft-manifest.js`
- Modify: `server/features/tools/rea-components.js` (component table, ids), `server/features/tools/rea-checks.js` (add `checkCraftAnything`), `server/features/tools/verified-download.js` (allow `/storytold/craft-anything/releases/download/` on `github.com`)
- Test: `tests/unit/craft-manifest.test.js`, extend `tests/integration/rea-components.test.js`

**Interfaces:**

- Produces: `craftManifest` (`{ checked, version: "0.5.0", platforms: { "darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64" } }`, each entry `{ url, sha256, size, kind, top, binary, installedSize, remove?: ["bin/craft-anything"] }`); `craftPlatform({ platform, arch }, manifest = craftManifest) → { available, reason, entry }` (unavailable reason: `serverMessages.craft.platformUnavailable`); component id `"craft-anything"` in `reaComponentIds` (now `["rea-ghidra", "rea-jdk", "craft-anything"]`); `managedReaComponent(root, "craft-anything") → { version, directory, home }` where `home` is the folder holding the binary; `craftBinary(component) → path.join(component.home, "craft-anything-cli")`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/craft-manifest.test.js`: `every platform pins an https github release asset with sha256` (url matches `^https://github.com/storytold/craft-anything/releases/download/v0\.5\.0/`, sha256 64 hex, size > 0); `darwin x64 and arm64 share the universal zip`; `craftPlatform refuses win32 and freebsd with platformUnavailable`.

`tests/integration/rea-components.test.js` (reuse the fixture's `serve()`; build the archive with a fake `craft-anything-cli` shell script `#!/bin/sh\necho "craft-anything-cli 0.5.0"` plus a `bin/craft-anything` file for the tar case):

- `installs craft-anything from a zip and checks its version` → `managedReaComponent(root, "craft-anything").version === "0.5.0"`, binary executable.
- `drops the linux GUI binary after unpacking` → `bin/craft-anything` absent, `bin/craft-anything-cli` present.
- `refuses a binary that reports another version` → rejects with `serverMessages.craft.versionMismatch("0.5.0", "0.4.0")`, nothing published.
- `sweep removes an unpublished craft-anything version`.

- [ ] **Step 2: Run them to see them fail**

Run: `node --test tests/unit/craft-manifest.test.js tests/integration/rea-components.test.js`
Expected: FAIL (module missing, unknown component id).

- [ ] **Step 3: Implement**

`craft-manifest.js` with the Global Constraints values and a header comment saying where each value was checked (like `rea-manifest.js`). In `rea-components.js` add `"craft-anything": { name: "Craft Anything", home: (entry) => path.posix.dirname(entry.binary) === "." ? "" : path.posix.dirname(entry.binary), check: checkCraftAnything }` and apply `entry.remove` (relative paths, inside the version directory only) before `check`. `checkCraftAnything({ directory, entry, version, run, env, signal })` runs the binary with `--version` (timeout 10 s) and expects exactly `craft-anything-cli <version>`. Server messages `craft.platformUnavailable`, `craft.versionMismatch(expected, actual)` in de/en.

- [ ] **Step 4: Run the tests again**

Run: same command. Expected: PASS.

- [ ] **Step 5: Commit** — `feat: download and verify the pinned Craft Anything binary`

### Task 2: Craft Anything's config file and the Ghidra stub

**Files:**

- Create: `server/features/tools/craft-config.js`
- Test: `tests/unit/craft-config.test.js`

**Interfaces:**

- Produces: `craftHome(dataDir) → <dataDir>/craft-anything`; `sessionsConfigDir(dataDir) → <dataDir>/craft-anything/sessions`; `writeCraftConfig(configDir, { ghidra, jdk, stub }) → void` (ghidra/jdk: `managedReaComponent` results or null; stub: absolute stub path); `ensureGhidraStub(dataDir) → string` (path); `craftEnvironment(dataDir) → { CRAFT_ANYTHING_CONFIG_DIR, CRAFT_ANYTHING_NO_KEYCHAIN: "1" }`; `craftManagedKeys = ["CRAFT_ANYTHING_CONFIG_DIR", "CRAFT_ANYTHING_NO_KEYCHAIN"]`.

- [ ] **Step 1: Write the failing tests**

- `writes auto_mode and deep_mode off and the Ghidra paths` → parsed TOML has `auto_mode === false`, `deep_mode === false`, `engines.ghidra.install_dir === ghidra.home`, `engines.ghidra.java_home === jdk.home`.
- `without Ghidra points at the stub and drops java_home` → `install_dir === stub`, no `java_home`; the stub is mode 0o700 and running it exits 1 with the message from Global Constraints on stderr.
- `rewrite keeps foreign keys and resets ours` → a file with `theme = "studio"`, `deep_mode = true`, `ask_before_running = false` keeps `theme`, gets `deep_mode = false`; `ask_before_running` is left to Craft Anything (the row's `--restricted` covers it).
- `an unreadable config is replaced, never thrown` → a file with invalid TOML is rewritten with only AgentPier's keys.
- `refuses a config dir that is a link` (like `prepareReaHome`).

- [ ] **Step 2: Run** `node --test tests/unit/craft-config.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** with `smol-toml` `parse`/`stringify`, written through `writePrivate`-style 0600 atomic write; directories 0700.
- [ ] **Step 4: Run** again — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: keep Craft Anything's config pinned to AgentPier's choices`

### Task 3: `CraftTool`: install, update, remove, the managed row

**Files:**

- Create: `server/features/tools/craft-tool.js`, `server/features/tools/craft-lifecycle.js`
- Modify: `server/application/rea-wiring.js` → rename nothing; export the generic `reaInUse` as `managedRowInUse` (keep `reaInUse` as an alias)
- Test: `tests/integration/craft-tool.test.js`, `tests/helpers/craft-tool-fixture.js` (wraps `reaFixture`)

**Interfaces:**

- Consumes: Task 1 (`craftManifest`, `craftPlatform`, `installReaComponent`, `managedReaComponent`, `removeReaComponent`, `craftBinary`), Task 2, `reaManifest`/`reaPlatform` for Ghidra/JDK entries.
- Produces: `class CraftTool` with the same surface `ReaTool` offers the wiring and routes: `constructor({ dataDir, servers, changes, packages, extensions, audit, manifest, reaManifest, platform, arch, darwinMajor, fetchImpl, run, env })`, `state()`, `utility()`, `apply(input, { source })`, `update({ source })`, `uninstall()`, `start()`, `close()`, `settled()`, `bindingsChanged()`, `syncEnvironment()`, `serverId()`, `wantsGhidra() → boolean`, and hooks the wiring assigns: `inUse`, `onChange`, `keepsGhidra` (`() => boolean`, the other tool wants Ghidra). Stored choice in `<dataDir>/craft-anything/settings.json`: `{ serverId, components: { ghidra: boolean }, settings: { mode: "clean-room" | "deep" }, requested? }`. `state()` returns `{ available, reason, status, jobCount, step, message, installed, serverId, serverName, updateAvailable, components: { core: { installed, version, pinnedVersion, downloadSize, installedSize, outdated }, ghidra: { … as REA's, plus shared: boolean } }, settings }`. `utility()` returns `{ id: "craft-anything", name: "Craft Anything", utility: true, installed, version, pinnedVersion, updateAvailable, status }`.

- [ ] **Step 1: Write the failing tests** (`tests/integration/craft-tool.test.js`, fixture serves the fake archives of Task 1 and fake Ghidra/JDK archives from `reaFixture`)

- `first install needs confirmInstall` → 409 `serverMessages.craft.confirmationRequired`.
- `first install places the binary and creates a managed row bound to Claude` → row `transport: "stdio"`, `command === craftBinary(...)` via the `<dataDir>/clis/craft-anything` link path (not the version folder), `managed.tool === "craft-anything"`, `targetsOf(id).clis` deep-equals `["claude"]`.
- `row args` → `["mcp", "--restricted", "--allow-web", "--allow-capture", "--clean-room"]`; after `apply({ settings: { mode: "deep" } })` the last arg is `--deep`; row env equals `craftEnvironment(dataDir)`, locked keys `craftManagedKeys`.
- `name collision gives craft-anything-agentpier`.
- `reuses REA's Ghidra and JDK` → components installed first via `installReaComponent`; `apply({ components: { ghidra: true }, confirmInstall: true })` makes no Ghidra/JDK request (fixture `downloads` holds only the Craft Anything URL) and `state().components.ghidra.shared === true` when REA's stored choice wants Ghidra.
- `installs Ghidra when nobody has it` → both component links exist, config points at them.
- `linux-arm64 installs without Ghidra` → Ghidra row `available: false` with REA's reason, `apply({components:{ghidra:true}})` 409, config uses the stub.
- `update brings the binary to the pin` → an installed `0.4.0` record → `updateAvailable`, `update()` installs `0.5.0`.
- `uninstall removes row, binary and its skill copies; keeps Ghidra when keepsGhidra()`.
- `start() applies a requested install once and clears the request`; `start() updates an outdated, unused install`.
- `config is rewritten at start` (Review Focus 3).

- [ ] **Step 2: Run** `node --test tests/integration/craft-tool.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement**

Follow `ReaTool`'s job model (`begin`, `progress`, `jobCount`, `requireIdle`, `requireUnused`, one job at a time, `close()` aborts). Row creation: `changes.create({ name, transport: "stdio", command, args, env }, { confirmStdio: true, clis: ["claude"], managed: { tool: "craft-anything", lockedEnv: craftManagedKeys } })`; later changes of args/env through `changes.update(id, { revision, args?, env? }, { confirmStdio: true })` (managed fields may be patched by the tool itself; owner patches stay refused by `requireOwnerPatch`). Ghidra: if `components.ghidra` and the components are missing or below the pin, place them exactly as `ReaTool#placeComponents` does (share the code: move the placing loop into an exported `placeGhidra({ root, manifest, host, update, … })` in `rea-components.js` and call it from both tools). Removal of Ghidra only when `!this.keepsGhidra()`. `craft-lifecycle.js` holds `startCraft` (sweep is REA's `sweepReaComponents`, which now covers the craft id; requested install; outdated update; config rewrite; `syncEnvironment`) and `uninstallCraft`, mirroring `rea-lifecycle.js`. Server messages under `craft.*` (busy, inUse, confirmationRequired, notInstalled, rowBroken, installing, removing, configuring, copyingSkill, failed).

- [ ] **Step 4: Run** again — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: install Craft Anything as a managed MCP server`

### Task 4: Ghidra/JDK shared between REA and Craft Anything

**Files:**

- Modify: `server/features/tools/rea-tool.js` (`apply` `ghidraGoes`, `placeComponents`), `server/features/tools/rea-lifecycle.js` (`uninstallRea`), `server/features/tools/rea-state.js` (add `shared`)
- Test: extend `tests/integration/rea-tool.test.js`, new `tests/integration/shared-ghidra.test.js`

**Interfaces:**

- Consumes: `CraftTool#wantsGhidra`, `ReaTool#wantsGhidra` (new: `this.stored().components.ghidra`), hook `keepsGhidra` on both (default `() => false`).
- Produces: `ReaTool#keepsGhidra`, `state().components.ghidra.shared`.

- [ ] **Step 1: Write the failing tests**
- `REA turning Ghidra off keeps it while Craft Anything wants it` → links stay, REA's stored choice is off, its row env drops `GHIDRA_INSTALL_DIR`.
- `uninstalling REA keeps Ghidra for Craft Anything`; `uninstalling Craft Anything keeps Ghidra for REA`.
- `the last user removes Ghidra and the JDK`.
- `REA's dialog state says shared when Craft Anything uses Ghidra`.
- [ ] **Step 2: Run** `node --test tests/integration/rea-tool.test.js tests/integration/shared-ghidra.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** — in each removal path, skip `removeReaComponent` for `rea-ghidra`/`rea-jdk` when `this.keepsGhidra()`; the `requireUnused` check for "Ghidra goes" applies only when it really goes.
- [ ] **Step 4: Run** again — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: share Ghidra and the JDK between REA and Craft Anything`

### Task 5: Craft Anything's skill for the CLIs

**Files:**

- Create: `server/features/tools/craft-skill/craft-anything/SKILL.md` (from `crates/setup/src/skill.md` of craft-anything v0.5.0, keeping its frontmatter `name: craft-anything`; replace "Connect only when you need it" with: the tools come from AgentPier's managed server; never run `craft-anything-cli setup`, `doctor --fix` or edit MCP configs; a refused tool with reason `restricted_mode` cannot be enabled from a session — rebuilds are started in AgentPier; clean room/deep is the owner's switch in AgentPier. Add a first-line comment block with source URL, version and licence "MIT OR Apache-2.0, © Craft Anything contributors"), `server/features/tools/craft-skills.js`
- Test: `tests/unit/craft-skills.test.js`

**Interfaces:**

- Produces: `craftSkill = "craft-anything"`; `syncCraftSkills({ serverId, servers, extensions })` — same rules as `syncReaSkills` (copy into each bound CLI profile, the owner's own folder wins, unbound copies removed), but reads the skill from the shipped folder (`bundledSkills(dir)`/`skillPack(skill)` from the package-skills helpers) and installs with `extensions.installPackageSkill(profileId, pack, { serverId, registry: "agentpier", name: "craft-anything", version: craftManifest.version })`; on a version change it replaces owned copies (`extensions.replaceSkill`).
- [ ] **Step 1: Write the failing tests** — `copies the skill into bound Claude profiles only`; `leaves the owner's own craft-anything folder`; `unbinding removes the owned copy`; `a newer pinned version replaces the owned copy`; `the shipped SKILL.md never mentions craft-anything-cli setup as an instruction` (assert no line matching `/run `craft-anything-cli setup/`).
- [ ] **Step 2: Run** `node --test tests/unit/craft-skills.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement**, call it from `CraftTool#converge` (step `skills`) and `bindingsChanged`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: give the CLIs Craft Anything's skill`

### Task 6: Wiring, routes, live topic, utility row

**Files:**

- Create: `server/application/craft-wiring.js`, `server/http/routes/craft-anything.js`
- Modify: `server/application/services.js` (create after `rea`, hooks `onChange`, `inUse` via `managedRowInUse`, `keepsGhidra` both ways, `bindingsChanged` in the `CentralMcpChanges.onSaved` chain), `server/application/shutdown.js` (`await services.craft?.close()` beside REA's), `server/app.js` (`services.craft?.start()` after REA's start; mount routes), `server/features/tools/live-topics.js` (`craftJobChanged`, `defineJobTopic({ kind: "craft-anything", param: /current/, sampleMs: 1000, … read: () => services.craft.state() })`), `server/features/sessions/workspace-state.js` (utility row), `web/lib/live/live-topics.js` (`"job.craft-anything": { mode: "state", path: () => "/craft-anything", interval: 1000, sampled: true }`)
- Test: `tests/integration/craft-tool-routes.test.js`, extend `tests/integration/live-job-topics.test.js`, `tests/unit/live-topics.test.js`, `tests/blackbox/user-socket-denial.test.js`

**Interfaces:**

- Produces: `services.craft`; routes `GET /api/craft-anything` → `state()`, `POST /api/craft-anything` → 202 `apply(body)`, `POST /api/craft-anything/update` → 202, `DELETE /api/craft-anything` → `uninstall()`; 503 `assistantProblem("unavailable", 503)` without `services.craft`; `Cache-Control: no-store`; owner only. Topic `job.craft-anything:current`.
- [ ] **Step 1: Write the failing tests** — routes mirror `rea-tool-routes.test.js` (state, 202 apply, update, delete, 503, audit origin `managed`); live: `job.craft-anything pushes each job step and samples while running`; blackbox: `job.craft-anything:current is refused to a user socket`; workspace state lists the `craft-anything` utility.
- [ ] **Step 2: Run** `node --test tests/integration/craft-tool-routes.test.js tests/integration/live-job-topics.test.js tests/unit/live-topics.test.js tests/blackbox/user-socket-denial.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** as listed.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: serve Craft Anything's state and job over HTTP and the live channel`

### Task 7: Installer flag and the update path

**Files:**

- Create: `server/features/tools/craft-provisioning.js`
- Modify: `scripts/setup-options.mjs`, `scripts/setup.sh` (help), `scripts/install-bootstrap.sh` (both option whitelists), `scripts/release-install.mjs`, `scripts/setup-resume.mjs`
- Test: `tests/integration/craft-provisioning.test.js`

**Interfaces:**

- Produces: `provisionCraftAnything({ dataDir, enable, ghidra = true }) → { requested: boolean, installed: boolean }`: writes `requested: { components: { ghidra }, settings: { mode: "clean-room" } }` into `<dataDir>/craft-anything/settings.json` when enabled and not installed; never downloads (the server's `start()` does). Flag `--with-craft-anything` → `withCraftAnything: true` → installer argument `--with-craft-anything`.
- [ ] **Step 1: Write the failing tests** — `--with-craft-anything flows from setup options to the installer arguments`; `writes the request once`; `an installed Craft Anything is left alone`; `release install and resume call it with enable`.
- [ ] **Step 2: Run** `node --test tests/integration/craft-provisioning.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** beside the REA calls (after `rea`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: add --with-craft-anything to the installer`

### Task 8: The Craft Anything card and dialog

**Files:**

- Create: `web/features/tools/useCraftAnything.js`, `web/features/tools/CraftAnythingDialog.jsx`, `web/lib/i18n/de/craft-anything.js`, `web/lib/i18n/en/craft-anything.js`, `web/lib/i18n/messages/craft-anything.js`, `tests/browser/craft-anything.spec.js`, `tests/browser/craft-anything-fixture.js`
- Modify: `web/app/AppDialogs.jsx` (`modal?.type === "craft-anything"`), `web/features/dashboard/tool-actions.js`, `tool-action-view.js`, `ToolGrid.jsx`, `ToolRows.jsx`, `web/lib/providers.js` (`names["craft-anything"] = "Craft Anything"`), `web/features/mcp-servers/wizard/McpServerOverview.jsx` and `web/lib/i18n/{de,en}/mcp-servers.js` (managed note/link per tool: `managedManage` becomes a function of the tool name), `web/app/search-entries.js`
- Test: extend `tests/unit/tool-actions.test.js`, `tests/unit/search-index.test.js`, `tests/unit/quick-open.test.js`

**Interfaces:**

- Consumes: Task 6 routes and topic; REA's `ReaComponents.jsx` patterns (reuse its row rendering if it fits without growing it past 600 lines; otherwise a small shared row component in `web/features/tools/`).
- Produces: dialog sections — responsible-use note (Craft Anything's: software you own or may examine; no DRM, login or anti-cheat bypass; early alpha), components with sizes and total (Craft Anything always; "Ghidra with decompiler + Temurin JDK" optional, shows "shared with REA" when `shared`), "Deep mode for sessions" switch (`settings.mode`), Install/Update/Remove, job status from the topic.
- [ ] **Step 1: Write the failing tests**
  - unit: `toolActions` returns `[{ id: "craft-anything", install: !installed }]` for the utility; search: an entry `craft-anything` whose de/en labels contain "Craft Anything" and which opens `{ view: "coding", codingTab: "install" }`.
  - browser (stub `/api/craft-anything` like `rea-fixture.js`): `installs after acknowledging the note`, `shows Ghidra as shared with REA`, `switches deep mode for sessions`, `offers update when outdated`, `removes`, `managed row shows Manage Craft Anything and is read-only`, phone layout of the dialog footer.
- [ ] **Step 2: Run** `node --test tests/unit/tool-actions.test.js tests/unit/search-index.test.js tests/unit/quick-open.test.js && npx playwright test tests/browser/craft-anything.spec.js` — Expected: FAIL.
- [ ] **Step 3: Implement** with components from `docs/ui-guide.md` only; all copy in both catalogs; `npm run i18n:confirm -- craft-anything mcp-servers`.
- [ ] **Step 4: Run** the same commands plus `node --test tests/unit/ui-guide-rules.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat: add the Craft Anything card and dialog`

### Task 9: Docs and full check

**Files:**

- Modify: `docs/mcp.md` (new `#### Managed Craft Anything` after `#### Managed REA`: components and sizes, restricted session server and what it refuses, clean room/deep switch, config ownership, Ghidra shared, skill, update/remove, the stub; REA section: Ghidra is shared), `docs/installation.md` and `docs/linux.md` (`--with-craft-anything`), `docs/cli-updates.md` (the card's Update), `docs/architecture.md` (topic `job.craft-anything:current`, `GET /api/craft-anything`, sampled 1 s while running), `README.md`, `README.de.md` (one line beside REA), screenshot of the dialog under `docs/screenshots/`
- Delete before opening the PR: `docs/superpowers/plans/2026-11-08-craft-anything-managed-tool.md`; keep the spec until PR 2 merges (its decisions 4–7 are unfinished work).

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Run `npm run check` — Expected: exit 0.
- [ ] **Step 3:** Run `npm test` and `npm run test:e2e -- tests/browser/craft-anything.spec.js tests/browser/rea-tool.spec.js` — Expected: all pass.
- [ ] **Step 4:** Manual check on this Mac with a disposable data dir (`AGENTPIER_DATA_DIR` in the scratchpad): install with Ghidra off, confirm the row starts (`tools/list` over stdio answers) and `rebuild_start` is not listed.
- [ ] **Step 5: Commit** — `docs: describe the managed Craft Anything`
