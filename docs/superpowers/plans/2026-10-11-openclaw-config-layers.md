# Layered OpenClaw Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute the whole OpenClaw configuration from layered inputs with a locked core that holds on every start and live change, add a Gateway event hub, and verify the native interfaces later steps rely on.

**Architecture:** A pure compiler (`server/features/assistants/openclaw-config/`) merges base, owner overrides, per-agent entries and the locked core, in that order. `prepareRuntimeConfig` and all live `config.patch` writers use the same per-agent entry function and a shared patch helper, so a start and a live apply yield the same managed paths for the same inputs and runtime state (`guardProven`, `maintenance`). A separate event hub dispatches non-session Gateway events and records the hello's advertised methods and events.

**Tech Stack:** Node.js 22 ES modules, `node:test` with `node:assert/strict`, `node:sqlite` via the existing assistant store, OpenClaw Gateway RPC protocol 4.

**Spec:** `docs/superpowers/specs/2026-10-11-openclaw-config-layers-design.md`

## Global Constraints

- No visible behaviour change; existing assistant unit, integration and contract tests pass unchanged.
- The team contract and qualification tests must pass (`tests/integration/assistant-team-plugin-contract.test.js` and the qualification suites run by `.github/workflows/assistant-runtime.yml`).
- Pinned runtime: OpenClaw 2026.9.8 (`runtime-manifest.js`); do not change the manifest.
- Locked core is applied last; no override or profile can change a locked path.
- `gateway.terminal.enabled: false` and `gateway.controlUi.enabled: false` on every start (PR #210 adds the terminal key on `main`; rebase onto it before Task 3).
- Source and test files stay at or below 600 lines (`npm run check:structure`).
- Commit messages in English with `fix:`/`feat:`/`chore:`/`test:`/`docs:` prefixes, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests never touch the user's real instance, the default tmux server, `~/.openclaw` or port 4380; use `fs.mkdtempSync` data directories.

## Review Focus

- An existing `openclaw.json` that has drifted (for example `browser.enabled: true`, `channels.telegram` present, `update.auto.enabled: true`) is restored to the hardened values on the next start — pinned in Task 3.
- An override whose path is a parent of a locked path (`agents`, `gateway`, `""`) or uses array or prototype keys (`__proto__`, `constructor`) is rejected, not merged — pinned in Task 4.
- A live apply racing a concurrent change gets a stale `baseHash` rejection; the helper surfaces 409 instead of retrying blindly — pinned in Task 5.
- A Gateway that does not advertise a method a feature needs leads to a clear `unavailable` state rather than a thrown RPC error — pinned in Task 6.
- Events arriving while disconnected are lost; every reconnect triggers each handler's resync exactly once — pinned in Task 6.

---

### Task 1: Pin today's generated configuration

**Files:**

- Create: `tests/unit/openclaw-config-characterization.test.js`

**Interfaces:**

- Consumes: `prepareRuntimeConfig(paths, port, teams, { maintenance, tls })` from `server/features/assistants/runtime-config.js`; `runtimePaths(dir)` from `runtime-paths.js`; `readJSON`, `writePrivate` from `server/lib/storage.js`.
- Produces: a `fixture()` helper local to the file and golden assertions later tasks must keep green.

- [ ] **Step 1: Write the characterisation tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { prepareRuntimeConfig } from "../../server/features/assistants/runtime-config.js";
import { readJSON } from "../../server/lib/storage.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return runtimePaths(dir);
}
const teams = (extra = {}) => ({
  directory: "/private/plugin",
  connection: { url: "http://127.0.0.1:1235", token: "bridge" },
  hostMaxConcurrent: 4,
  ...extra,
});
const profile = {
  id: "a1",
  runtimeAgentId: "ap-a1",
  capabilities: { memory: true, reminders: true },
};

test("without teams the Gateway gets only session_status and no plugins", (t) => {
  const paths = fixture(t);
  prepareRuntimeConfig(paths, 1234);
  const config = readJSON(paths.config);
  assert.deepEqual(config.tools, { allow: ["session_status"], toolSearch: false });
  assert.deepEqual(config.plugins, { slots: { memory: "none" } });
  assert.equal(config.cron.enabled, false);
  assert.deepEqual(config.agents.defaults.skills, []);
  assert.equal(config.agents.defaults.maxConcurrent, 8);
  assert.equal(config.gateway.bind, "loopback");
  assert.equal(config.gateway.controlUi.enabled, false);
  assert.deepEqual(config.channels, {});
  assert.equal(config.browser.enabled, false);
});

test("native teams grant profile tools without guarded writes on a fresh start", (t) => {
  const paths = fixture(t);
  prepareRuntimeConfig(paths, 1234);
  const seeded = readJSON(paths.config);
  seeded.agents.entries = { "ap-a1": { id: "ap-a1", tools: { allow: ["write"] } } };
  fs.writeFileSync(paths.config, JSON.stringify(seeded));
  prepareRuntimeConfig(
    paths,
    1234,
    teams({ native: { token: "hook" }, profiles: [profile] }),
  );
  const config = readJSON(paths.config);
  assert.deepEqual(config.agents.entries["ap-a1"].tools.allow, [
    "session_status",
    "agentpier_team_propose",
    "agentpier_team_status",
    "agentpier_team_stop",
    "memory_search",
    "memory_get",
    "read",
    "agentpier_reminder",
    "agentpier_routine",
    "agentpier_workspace",
  ]);
  assert.equal(config.agents.entries["ap-a1"].memory.search.enabled, true);
  assert.equal(config.cron.enabled, true);
  assert.equal(config.agents.defaults.maxConcurrent, 12);
});

test("maintenance keeps native cron off", (t) => {
  const paths = fixture(t);
  prepareRuntimeConfig(paths, 1234, teams({ native: { token: "hook" }, profiles: [] }), {
    maintenance: true,
  });
  assert.equal(readJSON(paths.config).cron.enabled, false);
});

test("models and unknown keys of an existing file survive a start", (t) => {
  const paths = fixture(t);
  prepareRuntimeConfig(paths, 1234);
  const seeded = readJSON(paths.config);
  seeded.models = { providers: { p: { baseUrl: "http://127.0.0.1:9" } } };
  seeded.custom = { kept: true };
  fs.writeFileSync(paths.config, JSON.stringify(seeded));
  prepareRuntimeConfig(paths, 1234);
  const config = readJSON(paths.config);
  assert.deepEqual(config.models, seeded.models);
  assert.deepEqual(config.custom, { kept: true });
});
```

- [ ] **Step 2: Run them against unchanged code**

Run: `node --test tests/unit/openclaw-config-characterization.test.js`
Expected: PASS (they describe today's behaviour). If one fails, correct the expectation to match today's output before continuing; these tests are the refactor's safety net.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/openclaw-config-characterization.test.js
git commit -m "test: pin the generated OpenClaw configuration"
```

---

### Task 2: Share the per-agent entry between start and live apply

**Files:**

- Create: `server/features/assistants/openclaw-config/agent-entry.js`
- Modify: `server/features/assistants/runtime-config.js:105-120`
- Modify: `server/features/assistants/assistant-config.js:142-170`
- Test: `tests/unit/openclaw-agent-entry.test.js`

**Interfaces:**

- Consumes: `profileTools(assistant, teamsReady, nativeReady, writeGuard)` and `personalCapabilities(assistant)` from `native-capabilities.js`.
- Produces: `agentEntry(entry, assistant, { teamsReady, nativeReady, guardProven, agentRuntime }) -> entry` returning a new object with `tools.allow`, `memory.search` and, when given, `models.<m>.agentRuntime`.

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { agentEntry } from "../../server/features/assistants/openclaw-config/agent-entry.js";

const assistant = {
  id: "a1",
  runtimeAgentId: "ap-a1",
  capabilities: { memory: true, reminders: false },
};

test("an unproven write guard keeps write and edit out of the tool list", () => {
  const entry = agentEntry({ id: "ap-a1", model: "m" }, assistant, {
    teamsReady: true,
    nativeReady: true,
    guardProven: false,
  });
  assert.ok(!entry.tools.allow.includes("write"));
  assert.ok(entry.tools.allow.includes("read"));
  assert.equal(entry.model, "m");
  assert.deepEqual(entry.memory, {
    search: { enabled: true, rememberAcrossConversations: false },
  });
});

test("a proven guard grants writes and an agent runtime is recorded", () => {
  const entry = agentEntry({ id: "ap-a1" }, assistant, {
    teamsReady: true,
    nativeReady: true,
    guardProven: true,
    agentRuntime: { model: "codex/gpt", id: "codex" },
  });
  assert.ok(entry.tools.allow.includes("write"));
  assert.deepEqual(entry.models["codex/gpt"].agentRuntime, { id: "codex" });
});

test("without native teams memory search is left untouched", () => {
  const entry = agentEntry({ id: "ap-a1" }, assistant, {
    teamsReady: true,
    nativeReady: false,
    guardProven: false,
  });
  assert.equal(entry.memory, undefined);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/unit/openclaw-agent-entry.test.js`
Expected: FAIL with `Cannot find module .../openclaw-config/agent-entry.js`.

- [ ] **Step 3: Implement**

```js
import { personalCapabilities, profileTools } from "../native-capabilities.js";

// One definition for a Gateway start and a live apply: the same assistant and
// runtime state always yield the same managed entry paths.
export function agentEntry(
  entry,
  assistant,
  { teamsReady, nativeReady, guardProven, agentRuntime },
) {
  const next = { ...entry };
  if (teamsReady || nativeReady)
    next.tools = { allow: profileTools(assistant, teamsReady, nativeReady, guardProven) };
  if (nativeReady)
    next.memory = {
      search: {
        enabled: personalCapabilities(assistant).memory,
        rememberAcrossConversations: false,
      },
    };
  if (agentRuntime)
    next.models = {
      ...entry.models,
      [agentRuntime.model]: {
        ...entry.models?.[agentRuntime.model],
        agentRuntime: { id: agentRuntime.id },
      },
    };
  return next;
}
```

- [ ] **Step 4: Use it in both places**

In `runtime-config.js`, replace the loop body that sets `entry.tools` and `entry.memory` (lines 111-119) with:

```js
      const profile = teams.profiles?.find((a) => a.runtimeAgentId === (entry.id || key));
      if (!profile) continue;
      Object.assign(
        entry,
        agentEntry(entry, profile, { teamsReady: true, nativeReady: true, guardProven: false }),
      );
```

and add `import { agentEntry } from "./openclaw-config/agent-entry.js";`.

In `assistant-config.js`, replace the local `configure` arrow function with:

```js
const configure = (entry = {}) =>
  agentEntry(entry, assistant, {
    teamsReady: !!this.teamReady?.(),
    nativeReady,
    guardProven: !!this.writeGuard?.(),
    agentRuntime: lease.agentRuntime,
  });
```

and add the same import. Keep the existing readback checks unchanged.

- [ ] **Step 5: Run the new test, the characterisation tests and the assistant suites**

Run: `node --test tests/unit/openclaw-agent-entry.test.js tests/unit/openclaw-config-characterization.test.js && npm run test:unit -- --test-name-pattern=assistant && npm run test:integration -- --test-name-pattern=assistant`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/features/assistants/openclaw-config/agent-entry.js server/features/assistants/runtime-config.js server/features/assistants/assistant-config.js tests/unit/openclaw-agent-entry.test.js
git commit -m "refactor: share the OpenClaw agent entry between start and live apply"
```

---

### Task 3: Locked core enforced on every start

**Files:**

- Create: `server/features/assistants/openclaw-config/locked-core.js`
- Modify: `server/features/assistants/runtime-config.js`
- Test: `tests/unit/openclaw-locked-core.test.js`

**Interfaces:**

- Consumes: nothing new.
- Produces: `lockedPaths: string[]`; `isLockedPath(path: string) -> boolean` (true when the path equals, lies below, or is a parent of a locked path); `hardenedDefaults(): object` returning the values enforced on every start.

- [ ] **Step 1: Rebase onto main for the terminal key**

Run: `git fetch origin && git rebase origin/main`
Expected: clean rebase; `runtime-config.js` contains `terminal: { enabled: false }` once PR #210 is merged. If it is not merged yet, add the same line in this task.

- [ ] **Step 2: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { prepareRuntimeConfig } from "../../server/features/assistants/runtime-config.js";
import { isLockedPath } from "../../server/features/assistants/openclaw-config/locked-core.js";
import { readJSON } from "../../server/lib/storage.js";

test("a drifted configuration is hardened again on the next start", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locked-core-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  prepareRuntimeConfig(paths, 1234);
  const drifted = readJSON(paths.config);
  Object.assign(drifted, {
    channels: { telegram: { botToken: "x" } },
    browser: { enabled: true },
    skills: { allowBundled: ["github"] },
    discovery: { mdns: { mode: "full" } },
    telemetry: { enabled: true },
    update: { checkOnStart: true, auto: { enabled: true } },
  });
  drifted.agents.defaults.heartbeat = { every: "30m" };
  drifted.gateway.terminal = { enabled: true };
  fs.writeFileSync(paths.config, JSON.stringify(drifted));
  prepareRuntimeConfig(paths, 1234);
  const config = readJSON(paths.config);
  assert.deepEqual(config.channels, {});
  assert.equal(config.browser.enabled, false);
  assert.deepEqual(config.skills.allowBundled, []);
  assert.equal(config.discovery.mdns.mode, "off");
  assert.equal(config.telemetry.enabled, false);
  assert.deepEqual(config.update, { checkOnStart: false, auto: { enabled: false } });
  assert.deepEqual(config.agents.defaults.heartbeat, { every: "0m" });
  assert.equal(config.gateway.terminal.enabled, false);
});

test("locked paths include their children and their parents", () => {
  assert.equal(isLockedPath("gateway.auth.token"), true);
  assert.equal(isLockedPath("gateway"), true);
  assert.equal(isLockedPath("agents"), true);
  assert.equal(isLockedPath(""), true);
  assert.equal(isLockedPath("agents.defaults.skills"), true);
  assert.equal(isLockedPath("models.providers.x"), false);
  assert.equal(isLockedPath("agents.defaults.timeoutSeconds"), false);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test tests/unit/openclaw-locked-core.test.js`
Expected: FAIL (module missing; after creating it, the drift test fails on `channels`).

- [ ] **Step 4: Implement the locked core**

```js
// Paths AgentPier owns. A later capability step moves a path out of this list
// together with its safety rule.
export const lockedPaths = [
  "gateway",
  "update",
  "discovery",
  "telemetry",
  "diagnostics",
  "logging",
  "plugins",
  "tools",
  "cron",
  "channels",
  "browser",
  "memory",
  "skills.allowBundled",
  "skills.workshop",
  "agents.defaults.workspace",
  "agents.defaults.skills",
  "agents.defaults.maxConcurrent",
  "agents.defaults.heartbeat",
  "agents.entries",
  "agents.list",
];
export function isLockedPath(target) {
  return lockedPaths.some(
    (locked) =>
      target === "" ||
      target === locked ||
      target.startsWith(`${locked}.`) ||
      locked.startsWith(`${target}.`),
  );
}
// Written on every start, not only into a fresh file.
export function hardenedDefaults() {
  return {
    channels: {},
    browser: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    telemetry: { enabled: false },
    update: { checkOnStart: false, auto: { enabled: false } },
    skillsAllowBundled: [],
    heartbeat: { every: "0m" },
  };
}
```

In `runtime-config.js`, directly after the `config.agents = {...}` workspace assignment, add:

```js
const hardened = hardenedDefaults();
config.channels = hardened.channels;
config.browser = { ...config.browser, ...hardened.browser };
config.discovery = hardened.discovery;
config.telemetry = hardened.telemetry;
config.update = hardened.update;
config.skills = { ...config.skills, allowBundled: hardened.skillsAllowBundled };
config.agents.defaults.heartbeat = hardened.heartbeat;
```

and `import { hardenedDefaults } from "./openclaw-config/locked-core.js";`.

- [ ] **Step 5: Run the core, characterisation and team tests**

Run: `node --test tests/unit/openclaw-locked-core.test.js tests/unit/openclaw-config-characterization.test.js tests/unit/assistant-team-runtime-config.test.js tests/unit/assistant-runtime-config.test.js`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/features/assistants/openclaw-config/locked-core.js server/features/assistants/runtime-config.js tests/unit/openclaw-locked-core.test.js
git commit -m "fix: enforce the hardened OpenClaw defaults on every start"
```

---

### Task 4: Owner overrides layer

**Files:**

- Create: `server/features/assistants/openclaw-config/overrides.js`
- Modify: `server/features/assistants/assistant-schema.js`
- Modify: `server/features/assistants/runtime-config.js`
- Test: `tests/unit/openclaw-overrides.test.js`

**Interfaces:**

- Consumes: `isLockedPath` from Task 3; the assistant SQLite handle used by `assistant-store.js`.
- Produces: `validateOverride(path, value) -> { path, value }` (throws `assistantProblem("invalid", 400)`); `applyOverrides(config, overrides: {path,value}[]) -> config`; `OverrideStore(db)` with `list() -> {path,value,revision}[]`, `set(path, value)`, `remove(path)`; `prepareRuntimeConfig(..., { overrides })`.

- [ ] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  validateOverride,
  applyOverrides,
  OverrideStore,
} from "../../server/features/assistants/openclaw-config/overrides.js";
import { migrateAssistants } from "../../server/features/assistants/assistant-schema.js";

test("overrides cannot reach locked paths, their parents or prototype keys", () => {
  for (const target of [
    "gateway.auth.token",
    "agents",
    "",
    "tools.allow",
    "__proto__.polluted",
    "models.constructor.x",
    "models..x",
  ])
    assert.throws(() => validateOverride(target, 1), { status: 400 });
  assert.deepEqual(validateOverride("models.providers.p.timeout", 5), {
    path: "models.providers.p.timeout",
    value: 5,
  });
});

test("overrides merge below the locked core", () => {
  const config = applyOverrides({ models: { providers: { p: { a: 1 } } } }, [
    { path: "models.providers.p.timeout", value: 5 },
  ]);
  assert.deepEqual(config.models.providers.p, { a: 1, timeout: 5 });
  assert.equal(Object.prototype.polluted, undefined);
});

test("stored overrides keep a revision and can be removed", () => {
  const db = new DatabaseSync(":memory:");
  migrateAssistants(db);
  const store = new OverrideStore(db);
  store.set("models.providers.p.timeout", 5);
  store.set("models.providers.p.timeout", 7);
  assert.deepEqual(store.list(), [
    { path: "models.providers.p.timeout", value: 7, revision: 2 },
  ]);
  store.remove("models.providers.p.timeout");
  assert.deepEqual(store.list(), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/unit/openclaw-overrides.test.js`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

`overrides.js`:

```js
import { isLockedPath } from "./locked-core.js";
import { assistantProblem } from "../assistant-validation.js";

const segment = /^[A-Za-z0-9_-]{1,128}$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export function validateOverride(target, value) {
  const parts = String(target).split(".");
  if (
    !target ||
    parts.some((p) => !segment.test(p) || forbidden.has(p)) ||
    isLockedPath(target) ||
    value === undefined
  )
    throw assistantProblem("invalid", 400);
  return { path: target, value: structuredClone(value) };
}
export function applyOverrides(config, overrides) {
  const result = structuredClone(config);
  for (const { path: target, value } of overrides) {
    const { path: valid } = validateOverride(target, value);
    const parts = valid.split(".");
    let node = result;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(node, part) || typeof node[part] !== "object" || !node[part])
        node[part] = {};
      node = node[part];
    }
    node[parts.at(-1)] = structuredClone(value);
  }
  return result;
}
export class OverrideStore {
  constructor(db) {
    this.db = db;
  }
  list() {
    return this.db
      .prepare("SELECT path, value, revision FROM openclaw_overrides ORDER BY path")
      .all()
      .map((row) => ({
        path: row.path,
        value: JSON.parse(row.value),
        revision: row.revision,
      }));
  }
  set(target, value) {
    const valid = validateOverride(target, value);
    this.db
      .prepare(
        `INSERT INTO openclaw_overrides (path, value, revision) VALUES (?, ?, 1)
         ON CONFLICT(path) DO UPDATE SET value = excluded.value, revision = revision + 1`,
      )
      .run(valid.path, JSON.stringify(valid.value));
  }
  remove(target) {
    this.db.prepare("DELETE FROM openclaw_overrides WHERE path = ?").run(target);
  }
}
```

`assistant-schema.js`: append to the `db.exec` block:

```sql
    CREATE TABLE IF NOT EXISTS openclaw_overrides (path TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL);
```

`runtime-config.js`: extend the options to `{ maintenance = false, tls, overrides = [] } = {}` and, right after the `existing || {...}` base is chosen and before any core assignment, add:

```js
const config = applyOverrides(existing || freshDefaults(paths), overrides);
```

by moving the fresh literal into a local `freshDefaults(paths)` function in the same file. Add the import of `applyOverrides`.

- [ ] **Step 4: Separate the pure compiler from the file write**

Split `prepareRuntimeConfig` in `runtime-config.js` into a pure function and a thin writer, without changing any computed value:

```js
// Pure: the same inputs and runtime state always yield the same configuration.
export function compileOpenClawConfig({
  existing,
  paths,
  port,
  token,
  teams,
  overrides = [],
  runtime: { maintenance = false } = {},
  tls,
}) {
  const config = applyOverrides(existing || freshDefaults(paths), overrides);
  // ... all existing assignments of prepareRuntimeConfig, unchanged, in order,
  // using `maintenance` from `runtime` and `token` from the argument ...
  return config;
}
export function prepareRuntimeConfig(
  paths,
  port,
  teams,
  { maintenance = false, tls, overrides = [] } = {},
) {
  const existing = readJSON(paths.config, null);
  const token = existing?.gateway?.auth?.token || randomBytes(32).toString("hex");
  writePrivate(
    paths.config,
    compileOpenClawConfig({
      existing,
      paths,
      port,
      token,
      teams,
      overrides,
      runtime: { maintenance },
      tls,
    }),
  );
  return token;
}
```

Add to `tests/unit/openclaw-overrides.test.js`:

```js
test("compiling twice from the same inputs is deterministic and does not mutate them", async () => {
  const { compileOpenClawConfig } =
    await import("../../server/features/assistants/runtime-config.js");
  const { runtimePaths } =
    await import("../../server/features/assistants/runtime-paths.js");
  const paths = runtimePaths("/tmp/compile-pure");
  const existing = { agents: { defaults: {} }, models: { providers: {} } };
  const frozen = structuredClone(existing);
  const input = { existing, paths, port: 1, token: "t", overrides: [] };
  assert.deepEqual(compileOpenClawConfig(input), compileOpenClawConfig(input));
  assert.deepEqual(existing, frozen);
});
```

If the second assertion fails because the existing code mutates `config` in place, start from `structuredClone(existing)` inside `compileOpenClawConfig` (`applyOverrides` already clones, so this holds once Step 3 is in place).

- [ ] **Step 5: Run the tests**

Run: `node --test tests/unit/openclaw-overrides.test.js tests/unit/openclaw-locked-core.test.js tests/unit/openclaw-config-characterization.test.js`
Expected: all PASS.

- [ ] **Step 6: Wire stored overrides into the launch**

In `runtime-supervisor.js` `launch()`, pass `overrides: this.configOverrides?.() || []` to `prepareRuntimeConfig`. In `server/application/assistant-graph.js`, where the supervisor is constructed, set `configOverrides: () => new OverrideStore(assistantDb).list()` using the same database handle the assistant store opens. Add a unit test in `tests/unit/openclaw-overrides.test.js`:

```js
test("a launch writes stored overrides but never over the core", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { runtimePaths } =
    await import("../../server/features/assistants/runtime-paths.js");
  const { prepareRuntimeConfig } =
    await import("../../server/features/assistants/runtime-config.js");
  const { readJSON } = await import("../../server/lib/storage.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overrides-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  prepareRuntimeConfig(paths, 1234, undefined, {
    overrides: [{ path: "agents.defaults.timeoutSeconds", value: 600 }],
  });
  const config = readJSON(paths.config);
  assert.equal(config.agents.defaults.timeoutSeconds, 600);
  assert.equal(config.gateway.controlUi.enabled, false);
});
```

Run: `node --test tests/unit/openclaw-overrides.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/features/assistants/openclaw-config/overrides.js server/features/assistants/assistant-schema.js server/features/assistants/runtime-config.js server/features/assistants/runtime-supervisor.js server/application/assistant-graph.js tests/unit/openclaw-overrides.test.js
git commit -m "feat: store owner overrides for the OpenClaw configuration"
```

---

### Task 5: One live patch helper

**Files:**

- Create: `server/features/assistants/openclaw-config/live-patch.js`
- Modify: `server/features/assistants/assistant-config.js:102-110,183-191`
- Modify: `server/features/assistants/assistant-maintenance.js:155-161`
- Test: `tests/unit/openclaw-live-patch.test.js`

**Interfaces:**

- Consumes: a Gateway client with `call(method, params)`; `isLockedPath` is not used here (the core is AgentPier's own write).
- Produces: `patchConfig(client, build: (current) => { patch, replacePaths? } | null) -> { hash, config } | null` — reads `config.get`, calls `build(current.config)`, skips when it returns `null`, sends `config.patch` with `baseHash`, `raw` and `replacePaths`, and maps a stale-hash rejection to `assistantProblem("conflict", 409)`.

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";

function client(responses) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      const next = responses[method];
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(params) : next;
    },
  };
}

test("a patch carries the base hash and replace paths", async () => {
  const gateway = client({
    "config.get": { hash: "h1", config: { cron: { enabled: false } } },
    "config.patch": { ok: true },
  });
  await patchConfig(gateway, (current) =>
    current.cron.enabled
      ? null
      : { patch: { cron: { enabled: true } }, replacePaths: ["cron"] },
  );
  assert.deepEqual(gateway.calls[1], [
    "config.patch",
    {
      baseHash: "h1",
      raw: JSON.stringify({ cron: { enabled: true } }),
      replacePaths: ["cron"],
    },
  ]);
});

test("an unchanged value sends no patch", async () => {
  const gateway = client({
    "config.get": { hash: "h1", config: { cron: { enabled: true } } },
  });
  const result = await patchConfig(gateway, (c) =>
    c.cron.enabled ? null : { patch: {} },
  );
  assert.equal(result, null);
  assert.equal(gateway.calls.length, 1);
});

test("a stale base hash becomes a conflict", async () => {
  const stale = Object.assign(Error("stale"), { code: "CONFLICT", answered: true });
  const gateway = client({
    "config.get": { hash: "h1", config: {} },
    "config.patch": stale,
  });
  await assert.rejects(
    patchConfig(gateway, () => ({ patch: { a: 1 } })),
    { status: 409 },
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/unit/openclaw-live-patch.test.js`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

```js
import { assistantProblem } from "../assistant-validation.js";

// Every live OpenClaw configuration write goes through here, so a concurrent change
// surfaces as a conflict instead of being silently overwritten.
export async function patchConfig(client, build) {
  const current = await client.call("config.get", {});
  const change = build(current.config || {});
  if (!change) return null;
  try {
    await client.call("config.patch", {
      baseHash: current.hash,
      raw: JSON.stringify(change.patch),
      ...(change.replacePaths ? { replacePaths: change.replacePaths } : {}),
    });
  } catch (error) {
    if (error.answered && /CONFLICT|STALE|HASH/.test(error.code || ""))
      throw assistantProblem("conflict", 409);
    throw error;
  }
  return current;
}
```

The exact stale-hash error code is confirmed in Task 7; adjust the pattern there if the contract shows a different code.

- [ ] **Step 4: Switch the callers**

`assistant-maintenance.js` `setCron`:

```js
  async setCron(enabled) {
    const runtime = this.s.assistantRuntime;
    await patchConfig(runtime.client, (config) =>
      config.cron?.enabled === enabled ? null : { patch: { cron: { enabled } } },
    );
    // the existing cron.status polling loop stays unchanged below
```

`assistant-config.js` provider patch:

```js
if (lease.provider)
  await patchConfig(this.client, () => ({
    patch: { models: { providers: { [lease.providerId]: lease.provider } } },
  }));
```

`assistant-config.js` agent entry patch: keep the `patch`/`replacePaths` computation and replace the `config.get` + `config.patch` pair with:

```js
await patchConfig(this.client, (config) => {
  const agents = config.agents;
  // existing arrayKey / configure / patch construction, unchanged
  return { patch: { agents: patch }, replacePaths };
});
```

Add `import { patchConfig } from "./openclaw-config/live-patch.js";` to both files.

- [ ] **Step 5: Run unit and integration suites for assistants**

Run: `node --test tests/unit/openclaw-live-patch.test.js && npm run test:unit -- --test-name-pattern="assistant|maintenance" && npm run test:integration -- --test-name-pattern=assistant`
Expected: all PASS.

- [ ] **Step 6: Pin start and live equivalence**

Add to `tests/unit/openclaw-agent-entry.test.js`:

```js
test("a start and a live apply yield the same entry for the same runtime state", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { runtimePaths } =
    await import("../../server/features/assistants/runtime-paths.js");
  const { prepareRuntimeConfig } =
    await import("../../server/features/assistants/runtime-config.js");
  const { readJSON } = await import("../../server/lib/storage.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "equivalence-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  prepareRuntimeConfig(paths, 1234);
  const seeded = readJSON(paths.config);
  seeded.agents.entries = { "ap-a1": { id: "ap-a1" } };
  fs.writeFileSync(paths.config, JSON.stringify(seeded));
  prepareRuntimeConfig(paths, 1234, {
    directory: "/p",
    connection: { url: "http://127.0.0.1:1", token: "t" },
    hostMaxConcurrent: 1,
    native: { token: "n" },
    profiles: [assistant],
  });
  const started = readJSON(paths.config).agents.entries["ap-a1"];
  const live = agentEntry({ id: "ap-a1" }, assistant, {
    teamsReady: true,
    nativeReady: true,
    guardProven: false,
  });
  assert.deepEqual(started.tools, live.tools);
  assert.deepEqual(started.memory, live.memory);
});
```

Run: `node --test tests/unit/openclaw-agent-entry.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/features/assistants/openclaw-config/live-patch.js server/features/assistants/assistant-config.js server/features/assistants/assistant-maintenance.js tests/unit/openclaw-live-patch.test.js tests/unit/openclaw-agent-entry.test.js
git commit -m "refactor: send live OpenClaw configuration writes through one helper"
```

---

### Task 6: Gateway capabilities and event hub

**Files:**

- Modify: `server/features/assistants/gateway-client.js:112-116`
- Create: `server/features/assistants/gateway-event-hub.js`
- Modify: `server/features/assistants/assistant-service.js:26-43`
- Test: `tests/unit/gateway-event-hub.test.js`

**Interfaces:**

- Consumes: `GatewayClient` `subscribe(listener)` and the hello payload of `connect`.
- Produces: `client.features -> { methods: Set<string>, events: Set<string> }` set on every successful hello; `client.supports(method) -> boolean`; `GatewayEventHub` with `on(eventName, handler)`, `onReady(resync)`, `bind(client)` and `ready()`; handlers receive the event `payload`.

- [ ] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";

function fakeClient(methods = ["config.get"]) {
  const emitter = new EventEmitter();
  return {
    features: { methods: new Set(methods), events: new Set(["chat"]) },
    supports(method) {
      return this.features.methods.has(method);
    },
    subscribe(listener) {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
    emit: (frame) => emitter.emit("event", frame),
  };
}

test("events are dispatched by name and session events are ignored", () => {
  const hub = new GatewayEventHub();
  const seen = [];
  hub.on("exec.approval.requested", (payload) => seen.push(payload.id));
  const client = fakeClient();
  hub.bind(client);
  client.emit({ event: "exec.approval.requested", payload: { id: "e1" } });
  client.emit({ event: "chat", payload: { sessionKey: "s" } });
  assert.deepEqual(seen, ["e1"]);
});

test("every ready runs each resync exactly once and rebinding drops the old client", () => {
  const hub = new GatewayEventHub();
  let resyncs = 0,
    events = 0;
  hub.onReady(() => resyncs++);
  hub.on("x", () => events++);
  const first = fakeClient();
  hub.bind(first);
  hub.ready();
  const second = fakeClient();
  hub.bind(second);
  hub.ready();
  first.emit({ event: "x", payload: {} });
  second.emit({ event: "x", payload: {} });
  assert.equal(resyncs, 2);
  assert.equal(events, 1);
});

test("a handler that throws does not stop the others", () => {
  const hub = new GatewayEventHub();
  const seen = [];
  hub.on("x", () => {
    throw new Error("boom");
  });
  hub.on("x", () => seen.push(1));
  const client = fakeClient();
  hub.bind(client);
  client.emit({ event: "x", payload: {} });
  assert.deepEqual(seen, [1]);
});
```

Add to `tests/unit/gateway-client.test.js` (create it if missing, using the existing gateway test server helper in `tests/helpers/` that serves `connect.challenge` and `connect`):

```js
test("the hello's advertised methods and events are recorded", async () => {
  // Start the existing fake Gateway with hello { protocol: 4, features: { methods: ["config.get"], events: ["chat"] } }
  // connect a GatewayClient to it, then:
  assert.equal(client.supports("config.get"), true);
  assert.equal(client.supports("web.login.start"), false);
});
```

If no reusable fake Gateway exists, construct one inline with `ws`'s `WebSocketServer` on port 0 that sends `{type:"event",event:"connect.challenge",payload:{nonce:"n"}}` on connection and answers the `connect` request with `{type:"res",id,ok:true,payload:{protocol:4,features:{methods:["config.get"],events:["chat"]}}}`; connect with TLS disabled through the client's test option the existing gateway-client tests use.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/unit/gateway-event-hub.test.js tests/unit/gateway-client.test.js`
Expected: FAIL (module missing, `supports` undefined).

- [ ] **Step 3: Record features in the client**

In `gateway-client.js`, inside the `.then((hello) => {...})` after the protocol check:

```js
const features = hello?.features || {};
this.features = {
  methods: new Set(Array.isArray(features.methods) ? features.methods : []),
  events: new Set(Array.isArray(features.events) ? features.events : []),
};
```

and add the method:

```js
  supports(method) {
    return !!this.features?.methods.has(method);
  }
```

The hello's exact field names are confirmed in Task 7; adjust the property path there if the contract shows another shape.

- [ ] **Step 4: Implement the hub**

```js
// Non-session Gateway events. Events sent while disconnected are lost, so every
// ready runs each registered resync once.
export class GatewayEventHub {
  constructor() {
    this.handlers = new Map();
    this.resyncs = [];
  }
  on(name, handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push(handler);
  }
  onReady(resync) {
    this.resyncs.push(resync);
  }
  bind(client) {
    this.unsubscribe?.();
    this.unsubscribe = client?.subscribe((frame) => {
      if (frame.payload?.sessionKey) return;
      for (const handler of this.handlers.get(frame.event) || []) {
        try {
          handler(frame.payload);
        } catch {
          /* One failing handler must not stop the others. */
        }
      }
    });
  }
  ready() {
    for (const resync of this.resyncs)
      Promise.resolve()
        .then(resync)
        .catch(() => {});
  }
}
```

Note: `ready()` schedules resyncs asynchronously; in the unit test, `await new Promise(setImmediate)` before asserting `resyncs`. Update the test accordingly:

```js
hub.ready();
await new Promise(setImmediate);
```

and make that test `async`.

- [ ] **Step 5: Wire it into the service**

In `assistant-service.js`, construct `this.gatewayEvents = new GatewayEventHub()` in the constructor (export it for later steps through the service graph), and in the `becameReady` branch after `this.bindEvents();` add:

```js
this.gatewayEvents.bind(this.runtime.client);
this.gatewayEvents.ready();
```

Also bind once at construction next to the existing `this.bindEvents();`.

- [ ] **Step 6: Run the tests**

Run: `node --test tests/unit/gateway-event-hub.test.js tests/unit/gateway-client.test.js && npm run test:unit -- --test-name-pattern=assistant`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add server/features/assistants/gateway-client.js server/features/assistants/gateway-event-hub.js server/features/assistants/assistant-service.js tests/unit/gateway-event-hub.test.js tests/unit/gateway-client.test.js
git commit -m "feat: record Gateway features and dispatch non-session events"
```

---

### Task 7: Live native interface contract

**Files:**

- Create: `tests/integration/assistant-native-interfaces-contract.test.js`
- Modify: `.github/workflows/assistant-runtime.yml:104-118`
- Modify: `scripts/provision-assistant-contracts.mjs` (export `AGENTPIER_NATIVE_INTERFACES_CONTRACT_RUNTIME` like the other `*_RUNTIME` variables)
- Create: `docs/assistant-native-interface-qualification.md`
- Modify: `docs/assistant-release-qualification.md`
- Modify: `docs/adr/0002-managed-openclaw-assistants.md:432-454`
- Possibly modify: `live-patch.js` error pattern and `gateway-client.js` feature path, if the contract shows other shapes

**Interfaces:**

- Consumes: `RuntimeSupervisor({ dataDir, install })` as in `tests/integration/assistant-team-plugin-contract.test.js:105-116`; the deterministic model server `tests/helpers/assistant-model-server.js`; `patchConfig` (Task 5); `client.supports` (Task 6).
- Produces: recorded facts (event names, payload shapes, error codes) in the qualification doc, and the ADR coupling rows.

- [ ] **Step 1: Write the contract**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
import { startModelServer } from "../helpers/assistant-model-server.js";

const runtime = process.env.AGENTPIER_NATIVE_INTERFACES_CONTRACT_RUNTIME;

test(
  "OpenClaw exposes the native interfaces AgentPier builds on",
  {
    skip: !runtime && "set AGENTPIER_NATIVE_INTERFACES_CONTRACT_RUNTIME",
    timeout: 300000,
  },
  async (t) => {
    const install = JSON.parse(fs.readFileSync(runtime, "utf8"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-interfaces-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const supervisor = new RuntimeSupervisor({ dataDir, install: async () => install });
    t.after(() => supervisor.stop());
    await supervisor.start();
    const client = supervisor.client;

    // Locked core holds on the running Gateway.
    const { config } = await client.call("config.get", {});
    assert.equal(config.gateway.terminal.enabled, false);
    assert.equal(config.gateway.controlUi.enabled, false);

    // Advertised features.
    for (const method of [
      "config.schema",
      "config.schema.lookup",
      "config.patch",
      "channels.pairing.list",
      "web.login.start",
      "exec.approvals.get",
    ])
      assert.equal(client.supports(method), true, method);

    // Schema with UI hints and restart information.
    const schema = await client.call("config.schema", {});
    assert.equal(typeof schema.schema, "object");
    assert.ok(schema.uiHints || schema.hints, "UI hints present");
    const hot = await client.call("config.schema.lookup", {
      path: "agents.defaults.timeoutSeconds",
    });
    const cold = await client.call("config.schema.lookup", { path: "gateway.port" });
    t.diagnostic(`lookup hot=${JSON.stringify(hot)} cold=${JSON.stringify(cold)}`);
    assert.notDeepEqual(hot, cold);

    // replacePaths and stale hashes.
    await patchConfig(client, () => ({
      patch: { agents: { defaults: { timeoutSeconds: 600 } } },
    }));
    const stale = await client.call("config.get", {});
    await client.call("config.patch", {
      baseHash: stale.hash,
      raw: JSON.stringify({ agents: { defaults: { timeoutSeconds: 601 } } }),
    });
    await assert.rejects(
      client.call("config.patch", {
        baseHash: stale.hash,
        raw: JSON.stringify({ agents: { defaults: { timeoutSeconds: 602 } } }),
      }),
      (error) => {
        t.diagnostic(`stale hash code=${error.code}`);
        return error.answered === true;
      },
    );

    // Pairing list answers with the operator scopes AgentPier requests.
    const pairing = await client.call("channels.pairing.list", {});
    t.diagnostic(`pairing=${JSON.stringify(pairing)}`);
    assert.ok(pairing);
  },
);

test(
  "an exec request in ask mode raises an approval event and a denied command never runs",
  {
    skip: !runtime && "set AGENTPIER_NATIVE_INTERFACES_CONTRACT_RUNTIME",
    timeout: 300000,
  },
  async (t) => {
    const install = JSON.parse(fs.readFileSync(runtime, "utf8"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-exec-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const marker = path.join(dataDir, "ran");
    const model = await startModelServer({
      toolCall: { name: "exec", arguments: { command: `touch ${marker}` } },
    });
    t.after(() => model.close());
    const supervisor = new RuntimeSupervisor({ dataDir, install: async () => install });
    t.after(() => supervisor.stop());
    await supervisor.start();
    const client = supervisor.client;
    const events = [];
    client.subscribe((frame) => events.push(frame));
    // Test-only configuration: exec in ask mode for one agent, model from the fake server.
    await patchConfig(client, () => ({
      patch: {
        models: { providers: { fake: model.provider } },
        tools: { allow: ["session_status", "exec"], exec: { mode: "ask" } },
      },
    }));
    const session = await client.call("sessions.create", {
      agentId: "main",
      model: model.ref,
    });
    await client.call("sessions.send", { key: session.key, message: "run it" });
    const deadline = Date.now() + 60000;
    let approval;
    while (!approval && Date.now() < deadline) {
      approval = events.find((e) => /approval/i.test(e.event));
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(approval, "an approval event arrived");
    t.diagnostic(
      `approval event=${approval.event} payload=${JSON.stringify(approval.payload)}`,
    );
    assert.equal(fs.existsSync(marker), false, "nothing ran before a decision");
  },
);
```

Notes for the implementer:

- `startModelServer` and its `toolCall` option, `model.provider` and `model.ref` must match `tests/helpers/assistant-model-server.js`; read it first and follow how `assistant-team-plugin-contract.test.js` points an agent at the fake model. If the helper has no tool-call mode, add one there (respond once with a tool call to the given tool and arguments) and reuse it.
- The supervisor's locked core sets `tools`, so the test-only `config.patch` above is the deliberate way to open `exec` for this contract; it does not go through `prepareRuntimeConfig`.
- Record every `t.diagnostic` value in the qualification doc in Step 4.

- [ ] **Step 2: Provision and run locally**

Run: `node scripts/provision-assistant-contracts.mjs > /tmp/contract-env && set -a && . /tmp/contract-env && set +a && node --test tests/integration/assistant-native-interfaces-contract.test.js`
Expected: PASS with diagnostics printed. First run downloads the runtime (several minutes).

- [ ] **Step 3: Align code with observed facts**

If the stale-hash code differs from `/CONFLICT|STALE|HASH/`, update `live-patch.js` and its unit test. If hello features live under another field, update `gateway-client.js` and its test. Re-run Tasks 5 and 6 tests.

- [ ] **Step 4: Document**

Create `docs/assistant-native-interface-qualification.md` with the same sections as `docs/assistant-memory-qualification.md`: Running the contract (env variable and command), Result (date, OpenClaw 2026.9.8, platform, TAP path), Covered behavior (each assertion above with the recorded event names, payload fields, stale-hash code, lookup output), Boundaries (WhatsApp login not exercised until the plugin is in the runtime lock). Add a row to "Deeper checks" in `docs/assistant-release-qualification.md`. In `docs/adr/0002-managed-openclaw-assistants.md`, add coupling rows for `config.schema` / `config.schema.lookup`, `config.patch` with `baseHash` and `replacePaths`, the exec approval event and methods, `channels.pairing.*`, `web.login.*`, the hello feature lists, and the locked-path list in `openclaw-config/locked-core.js`; extend the requalification checklist with "run the native interfaces contract".

- [ ] **Step 5: Add the contract to CI**

In `.github/workflows/assistant-runtime.yml`, add `tests/integration/assistant-native-interfaces-contract.test.js` to the contract file list (lines 104-118) and export `AGENTPIER_NATIVE_INTERFACES_CONTRACT_RUNTIME` from `scripts/provision-assistant-contracts.mjs` the same way the team contract variable is exported.

- [ ] **Step 6: Run the full checks**

Run: `npm run check`
Expected: lint, format, structure, build and backend tests PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/integration/assistant-native-interfaces-contract.test.js tests/helpers/assistant-model-server.js .github/workflows/assistant-runtime.yml scripts/provision-assistant-contracts.mjs docs/assistant-native-interface-qualification.md docs/assistant-release-qualification.md docs/adr/0002-managed-openclaw-assistants.md server/features/assistants/openclaw-config/live-patch.js server/features/assistants/gateway-client.js tests/unit
git commit -m "test: qualify the native OpenClaw interfaces for configuration, approvals and pairing"
```

---

### Task 8: Team regression and cleanup

**Files:**

- Delete: `docs/superpowers/specs/2026-10-11-openclaw-config-layers-design.md` and this plan, in the final cleanup commit before the pull request (AGENTS.md rule for completed plans and specs).

- [ ] **Step 1: Run the team contract and qualification suites**

Run: `set -a && . /tmp/contract-env && set +a && node --test tests/integration/assistant-team-plugin-contract.test.js tests/integration/assistant-memory-contract.test.js tests/integration/assistant-runtime-provisioning.test.js`
Expected: PASS with `# skipped 0`.

- [ ] **Step 2: Run the whole Node suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Remove the working documents and commit**

```bash
git rm docs/superpowers/specs/2026-10-11-openclaw-config-layers-design.md docs/superpowers/plans/2026-10-11-openclaw-config-layers.md
git commit -m "chore: remove completed OpenClaw configuration working documents"
```

- [ ] **Step 4: Push and open the pull request**

Describe the problem (hardening applied only on first start, scattered live writes), the resulting behaviour (locked core on every start, one compiler path, event hub, qualified interfaces) and validation (unit tests, contract output). Link AGENTPIER-23. Enqueue with `gh pr merge <nr> --auto` once required checks pass.
