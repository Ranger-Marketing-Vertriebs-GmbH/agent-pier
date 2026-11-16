# Runtime Descriptor, Step 1 (Traits) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each agent runtime states its behaviour as traits in one descriptor, and the
web app and server read those traits instead of comparing a runtime id.

**Architecture:** A trait schema owned by AgentPier (`runtime-traits.js`) names every
trait, its allowed values and its default (OpenClaw's behaviour). Each runtime has a
static descriptor (`runtimes/<id>/descriptor.js`) with its trait values; the registry
in `runtime-for.js` is built from the descriptors, and each capability in
`runtimeInfo.capabilities` carries its feature's traits beside `available`. The web app
reads them through one helper and gets the list of runtimes from a new route, so the
wizard knows a runtime's traits before an agent exists. A rule test forbids runtime
ids outside the runtime modules, with an allowlist that may only shrink.

**Tech Stack:** Node.js ES modules, Express, React, `node:test` with strict assertions.

**Spec:** `docs/superpowers/specs/2026-11-16-runtime-manifest-design.md` (this plan is
its delivery step 1; steps 2 to 6 get their own plans once this one is merged, because
their tasks build on the names and files this one creates).

## Global Constraints

- No behaviour change for existing agents: every screen and every refusal answers as
  before. The one intended difference is named in Review Focus 3.
- The property stays `runtimeInfo.capabilities`; a capability is
  `{ available: true|false, reason?, …traits }`.
- A trait names behaviour, never a runtime (`memoryFormat: "entries"`, not
  `kind: "hermes"`).
- Source and test files stay under 600 lines (`npm run check:structure`).
- UI text changes keep German and English catalogs in step and need
  `npm run i18n:confirm` with the updated `translation-lock.json` committed.
- Commit messages in English with the prefixes `feat:`, `fix:`, `chore:`.
- Work in this worktree (`.worktrees/runtime-manifest`); run git commands one at a
  time, not chained.
- Run a single test file with `node --test <file>`; before the last commit run
  `npm run check`.

## Review Focus

1. **A Hermes agent while its host is stopped or the supervisor is missing.**
   `runtimeDetails` answers `capabilities: {}` today, so "Every command" would vanish
   from the agent's settings. Traits are static: they must be present without a host.
   (Task 2)
2. **An agent view without `runtimeInfo`** (list still loading, a view from a test
   double). The web helper answers the schema defaults, which are OpenClaw's. (Task 4)
3. **An agent whose runtime this AgentPier lacks.** Every capability stays unavailable
   with `runtimeUnknown`; traits are the defaults; nothing throws. (Task 2)
4. **The wizard before the runtime list arrived, or after the request failed.** A
   duplicate of a Hermes agent must keep "Every command" and its model; nothing is
   cleared while the runtime's traits are unknown. (Task 5)
5. **A descriptor that states a wrong trait.** An unknown feature, an unknown trait or
   a value outside the schema fails at module load with a `TypeError` that names it,
   not at the first read. (Task 1)

---

## File structure

| File                                                               | Responsibility                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `server/features/assistants/runtimes/runtime-traits.js` (new)      | The trait schema, defaults and validation. Public module of the port.            |
| `server/features/assistants/runtimes/openclaw/descriptor.js` (new) | OpenClaw's id, name and traits.                                                  |
| `server/features/assistants/runtimes/hermes/descriptor.js` (new)   | Hermes's id, name and traits.                                                    |
| `server/features/assistants/runtimes/agent-runtime.js`             | `defineRuntimeDescriptor`; `defineAgentRuntime` merges traits into capabilities. |
| `server/features/assistants/runtimes/runtime-for.js`               | Registry from descriptors; `traitOf`; `runtimeList`; static traits in details.   |
| `server/http/routes/assistants.js`                                 | `GET /api/assistant-runtimes`.                                                   |
| `web/features/assistants/runtime-traits.js` (new)                  | Web defaults and `traitOf(runtimeInfo, feature, trait)`.                         |
| `web/features/assistants/useRuntimes.js` (new)                     | The runtime list, read once; `infoOf(id)`.                                       |
| `tests/helpers/runtime-id-scan.js` (new)                           | Scanner for runtime ids and runtime-named files outside the runtime modules.     |
| `docs/adr/0007-runtime-descriptor.md` (new)                        | The decision record.                                                             |

---

### Task 1: Trait schema

**Files:**

- Create: `server/features/assistants/runtimes/runtime-traits.js`
- Test: `tests/unit/runtime-traits.test.js`

**Interfaces:**

- Produces:
  - `RUNTIME_TRAITS`: frozen `{ [feature]: { [trait]: { default, allows(value) } } }`
    with exactly these entries:

    | Feature       | Trait          | Allowed                                                       | Default                       |
    | ------------- | -------------- | ------------------------------------------------------------- | ----------------------------- |
    | `approvals`   | `shellLevels`  | array, subset of `off`, `approval`, `every`, `full`, no dupes | `["off", "approval", "full"]` |
    | `approvals`   | `allowlist`    | `"patterns"`, `"exactCommands"`                               | `"patterns"`                  |
    | `agentFiles`  | `memoryFormat` | `"markdown"`, `"entries"`                                     | `"markdown"`                  |
    | `agentFiles`  | `dreaming`     | `"host"`, `"agent"`                                           | `"host"`                      |
    | `models`      | `chatgptLogin` | `"any"`, `"agentpierHeld"`                                    | `"any"`                       |
    | `channelBots` | `peopleApply`  | `"live"`, `"restart"`                                         | `"live"`                      |
    | `sessions`    | `chatFolders`  | boolean                                                       | `false`                       |
    | `host`        | `process`      | `"shared"`, `"perAgent"`                                      | `"shared"`                    |
    | `host`        | `install`      | `"builtin"`, `"optional"`                                     | `"builtin"`                   |

  - `resolveTraits(stated = {}): { [feature]: { [trait]: value } }`: deep-frozen, every
    schema trait present, stated values over defaults. Throws `TypeError` naming
    `feature.trait` for an unknown feature, an unknown trait or a refused value.
  - `DEFAULT_TRAITS = resolveTraits()`.

- [ ] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TRAITS,
  RUNTIME_TRAITS,
  resolveTraits,
} from "../../server/features/assistants/runtimes/runtime-traits.js";

test("the defaults are OpenClaw's behaviour", () => {
  assert.deepEqual(DEFAULT_TRAITS, {
    approvals: { shellLevels: ["off", "approval", "full"], allowlist: "patterns" },
    agentFiles: { memoryFormat: "markdown", dreaming: "host" },
    models: { chatgptLogin: "any" },
    channelBots: { peopleApply: "live" },
    sessions: { chatFolders: false },
    host: { process: "shared", install: "builtin" },
  });
});

test("stated values replace defaults, the rest stays", () => {
  const traits = resolveTraits({ agentFiles: { memoryFormat: "entries" } });
  assert.equal(traits.agentFiles.memoryFormat, "entries");
  assert.equal(traits.agentFiles.dreaming, "host");
  assert.ok(Object.isFrozen(traits) && Object.isFrozen(traits.agentFiles));
  assert.ok(Object.isFrozen(traits.approvals.shellLevels));
});

test("a wrong statement fails with the trait's name", () => {
  assert.throws(() => resolveTraits({ kanban: {} }), /kanban/);
  assert.throws(() => resolveTraits({ host: { kind: "hermes" } }), /host\.kind/);
  assert.throws(() => resolveTraits({ host: { process: "fleet" } }), /host\.process/);
  assert.throws(
    () => resolveTraits({ approvals: { shellLevels: ["off", "sudo"] } }),
    /approvals\.shellLevels/,
  );
  assert.throws(
    () => resolveTraits({ approvals: { shellLevels: ["off", "off"] } }),
    /approvals\.shellLevels/,
  );
  assert.throws(() => resolveTraits({ sessions: { chatFolders: "yes" } }), TypeError);
});

test("every schema entry accepts its own default", () => {
  for (const traits of Object.values(RUNTIME_TRAITS))
    for (const { default: value, allows } of Object.values(traits))
      assert.equal(allows(value), true);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/unit/runtime-traits.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `runtime-traits.js`** with the three exports above. The
      feature names must be capability names (`RUNTIME_CAPABILITIES` in
      `agent-runtime.js`); do not import that module here, Task 2 checks it.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/unit/runtime-traits.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/assistants/runtimes/runtime-traits.js tests/unit/runtime-traits.test.js
git commit -m "feat: add the runtime trait schema"
```

---

### Task 2: Descriptors, traits in capabilities, server readers

**Files:**

- Create: `server/features/assistants/runtimes/openclaw/descriptor.js`,
  `server/features/assistants/runtimes/hermes/descriptor.js`
- Modify: `server/features/assistants/runtimes/agent-runtime.js` (capability list near
  line 325, `defineAgentRuntime` near line 354),
  `server/features/assistants/runtimes/runtime-for.js` (registry lines 19 to 41,
  `keepsExecAllowlist` line 106, `runtimeDetails` line 212),
  `server/features/assistants/runtimes/openclaw/openclaw-runtime.js:70`,
  `server/features/assistants/runtimes/hermes/hermes-runtime.js:39-42`,
  `server/features/assistants/own-process-agents.js:35-55`,
  `server/features/assistants/chat-file-folders.js:20`,
  `tests/helpers/runtime-port-scan.js` (`publicPortModules`)
- Test: `tests/unit/runtime-descriptors.test.js` (new); update
  `tests/unit/agent-runtime-field.test.js`, `tests/unit/hermes-runtime.test.js`,
  `tests/blackbox/agent-runtime-routes.test.js`,
  `tests/integration/hermes-routes.test.js`, `tests/helpers/runtime-port-contract.js`

**Interfaces:**

- Consumes: `resolveTraits`, `DEFAULT_TRAITS` (Task 1).
- Produces:
  - `defineRuntimeDescriptor({ id, name, traits = {} })` in `agent-runtime.js`: frozen
    `{ id, name, traits: resolveTraits(traits) }`; `TypeError` without `id` or `name`.
  - `openClawDescriptor` (`id: "openclaw"`, `name: "OpenClaw"`, no stated traits) and
    `hermesDescriptor` (`id: "hermes"`, `name: "Hermes Agent"`) with

    ```js
    traits: {
      approvals: { shellLevels: ["off", "approval", "every", "full"],
                   allowlist: "exactCommands" },
      agentFiles: { memoryFormat: "entries", dreaming: "agent" },
      models: { chatgptLogin: "agentpierHeld" },
      channelBots: { peopleApply: "restart" },
      sessions: { chatFolders: true },
      host: { process: "perAgent", install: "optional" },
    }
    ```

  - `defineAgentRuntime({ id, capabilities, traits, ...ports })`: `traits` is a
    descriptor's resolved `traits`; `capabilities()[name]` is
    `{ ...availability, ...traits[name] }`, frozen. Without `traits`, `DEFAULT_TRAITS`.
  - `RUNTIME_CAPABILITIES` loses `everyCommandApproval` (it is
    `approvals.shellLevels` now). `advancedSettings` and `channelBots` stay.
  - In `runtime-for.js`:
    - `traitOf(agent, feature, trait)`: the value for the agent's runtime
      (`runtimeIdOf`), read from the descriptor, no supervisor needed; the schema
      default for a runtime this AgentPier lacks; `TypeError` for a trait the schema
      does not name.
    - `runtimeDetails(agent, supervisor)`: as today, and without a usable supervisor
      `capabilities` is each feature's traits (no `available` key) instead of `{}`.
    - `runtimeList(supervisor)`: `RUNTIME_IDS.map((id) => runtimeDetails({ runtime: id }, supervisor))`.
    - `keepsExecAllowlist(agent)` keeps its 409 for an unknown runtime and answers
      `traitOf(agent, "approvals", "allowlist") === "patterns"`. The registry's
      `execAllowlist` flag and its `name` go; both come from the descriptor.

- [ ] **Step 1: Write the failing tests** in `tests/unit/runtime-descriptors.test.js`

```js
test("trait features are capabilities", () => {
  for (const feature of Object.keys(RUNTIME_TRAITS))
    assert.ok(RUNTIME_CAPABILITIES.includes(feature), feature);
});

test("OpenClaw states the defaults, Hermes its own", () => {
  assert.deepEqual(openClawDescriptor.traits, DEFAULT_TRAITS);
  assert.deepEqual(hermesDescriptor.traits.approvals.shellLevels, [
    "off",
    "approval",
    "every",
    "full",
  ]);
  assert.equal(hermesDescriptor.traits.host.install, "optional");
});

test("traitOf reads the agent's runtime without a supervisor", () => {
  assert.equal(traitOf({ runtime: "hermes" }, "sessions", "chatFolders"), true);
  assert.equal(traitOf({ runtime: "openclaw" }, "sessions", "chatFolders"), false);
  assert.equal(traitOf(null, "approvals", "allowlist"), "patterns");
  assert.equal(traitOf({ runtime: "next" }, "host", "process"), "shared");
  assert.throws(() => traitOf(null, "host", "kind"), TypeError);
});

test("a capability carries its traits beside its availability", () => {
  const runtime = defineAgentRuntime({ id: "x", traits: hermesDescriptor.traits });
  assert.deepEqual(runtime.capabilities().sessions, {
    available: true,
    chatFolders: true,
  });
  assert.equal("everyCommandApproval" in runtime.capabilities(), false);
});

test("details carry traits while no host answers", () => {
  const details = runtimeDetails({ runtime: "hermes" }, null);
  assert.equal(details.name, "Hermes Agent");
  assert.deepEqual(details.capabilities.approvals, {
    shellLevels: ["off", "approval", "every", "full"],
    allowlist: "exactCommands",
  });
});

test("an unknown runtime is unavailable with default traits", () => {
  const { capabilities } = runtimeDetails({ runtime: "next" }, null);
  assert.deepEqual(capabilities.sessions, {
    available: false,
    reason: "runtimeUnknown",
    chatFolders: false,
  });
});

test("the list names every runtime this AgentPier ships", () => {
  assert.deepEqual(
    runtimeList(null).map((r) => r.id),
    ["openclaw", "hermes"],
  );
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/unit/runtime-descriptors.test.js`
Expected: FAIL, missing exports.

- [ ] **Step 3: Implement** the descriptors, `defineRuntimeDescriptor`, the trait
      merge in `defineAgentRuntime`, the registry from descriptors, `traitOf`,
      `runtimeList` and the `runtimeDetails` change. Pass
      `traits: openClawDescriptor.traits` / `hermesDescriptor.traits` where the two
      adapters call `defineAgentRuntime`, and drop both `everyCommandApproval` entries.
      Add `runtime-traits.js` to `publicPortModules` in
      `tests/helpers/runtime-port-scan.js`.

- [ ] **Step 4: Move the server readers**
  - `own-process-agents.js` `refuseEveryCommand`: refuse when
    `!traitOf(agent, "approvals", "shellLevels").includes("every")`; same problem id
    `shellEveryCommandUnsupported`, 400.
  - `own-process-agents.js` `refuseModelChoice`: replace `ownProcess(agent)` with
    `traitOf(agent, "models", "chatgptLogin") === "agentpierHeld"`.
  - `chat-file-folders.js` `keepsChatFolders`: `traitOf(agent, "sessions", "chatFolders")`.

- [ ] **Step 5: Update the existing tests** that name `everyCommandApproval`
      (`agent-runtime-field.test.js:174`, `hermes-runtime.test.js:86`,
      `agent-runtime-routes.test.js:66`, `hermes-routes.test.js:87`) to assert
      `capabilities.approvals.shellLevels` instead, with and without `"every"`.

- [ ] **Step 6: Run the affected suites**

Run: `node --test tests/unit/runtime-descriptors.test.js tests/unit/agent-runtime-field.test.js tests/unit/hermes-runtime.test.js tests/unit/agent-runtime-port.test.js tests/unit/runtime-port-rules.test.js tests/blackbox/agent-runtime-routes.test.js tests/integration/hermes-routes.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server tests
git commit -m "feat: state runtime traits in descriptors and read them on the server"
```

---

### Task 3: The runtime list route and its web reader

**Files:**

- Modify: `server/http/routes/assistants.js` (beside `GET /assistant-runtime`, line
  270), `web/features/assistants/assistant-api.js`
- Create: `web/features/assistants/useRuntimes.js`
- Test: `tests/blackbox/agent-runtime-routes.test.js` (extend),
  `tests/unit/use-runtimes.test.js` (new, for the pure part)

**Interfaces:**

- Consumes: `runtimeList(supervisor)` (Task 2).
- Produces:
  - `GET /api/assistant-runtimes` → `{ runtimes: [{ id, name, version, capabilities }] }`,
    behind the same guards as `GET /api/assistant-runtime`.
  - `assistantApi.runtimes(signal)` → that body.
  - `runtimeInfoOf(runtimes, id)` (pure, exported from `useRuntimes.js`): the entry
    with that id; for `""`, `null` or `undefined` the first entry (the server's
    default); `undefined` when the list is empty or names no such runtime.
  - `useRuntimes()` → `{ runtimes, infoOf(id) }`; reads once on mount, `runtimes` is
    `[]` until the answer and after a failure. No polling.

- [ ] **Step 1: Write the failing tests**

Blackbox, in the style of the file's existing route tests:

```js
test("GET /api/assistant-runtimes lists the shipped runtimes with their traits", async () => {
  const { runtimes } = await getJson("/api/assistant-runtimes");
  assert.deepEqual(
    runtimes.map((r) => r.id),
    ["openclaw", "hermes"],
  );
  assert.equal(runtimes[1].capabilities.host.install, "optional");
  assert.equal(runtimes[0].capabilities.approvals.shellLevels.includes("every"), false);
});
```

Unit:

```js
test("runtimeInfoOf: the default is the first entry", () => {
  const list = [{ id: "openclaw" }, { id: "hermes" }];
  assert.equal(runtimeInfoOf(list, ""), list[0]);
  assert.equal(runtimeInfoOf(list, undefined), list[0]);
  assert.equal(runtimeInfoOf(list, "hermes"), list[1]);
  assert.equal(runtimeInfoOf(list, "next"), undefined);
  assert.equal(runtimeInfoOf([], ""), undefined);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/blackbox/agent-runtime-routes.test.js tests/unit/use-runtimes.test.js`
Expected: FAIL (404, missing module).

- [ ] **Step 3: Implement** the route, `assistantApi.runtimes` and `useRuntimes.js`
      (follow `useHermesRuntime.js` for the abortable read, without its interval).

- [ ] **Step 4: Run the tests**

Run: same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/http/routes/assistants.js web/features/assistants/assistant-api.js web/features/assistants/useRuntimes.js tests
git commit -m "feat: list the agent runtimes with their traits"
```

---

### Task 4: Web trait helper and the agent settings

**Files:**

- Create: `web/features/assistants/runtime-traits.js`
- Modify: `web/features/assistants/shell-level.js:15-16`,
  `web/features/assistants/runtime-capabilities.js:44-67`,
  `web/features/assistants/settings/ProfileFields.jsx:92`,
  `web/features/assistants/settings/CapabilitiesTab.jsx:58`,
  `web/features/assistants/settings/CapabilityGroups.jsx:50`,
  `web/features/assistants/TelegramSendersSettings.jsx:15`
- Test: `tests/unit/runtime-traits-web.test.js` (new); update
  `tests/unit/hermes-runtime-web.test.js`, `tests/unit/hermes-images.test.js`,
  `tests/browser/hermes-runtime.spec.js` (fixtures at lines 44 and 355)

**Interfaces:**

- Consumes: `runtimeInfo.capabilities[feature][trait]` (Task 2).
- Produces:
  - `traitDefaults` and `traitOf(runtimeInfo, feature, trait)` in
    `web/features/assistants/runtime-traits.js`: the value in
    `runtimeInfo.capabilities[feature]`, else the default; works for `undefined`.
  - `offersEveryCommand(runtimeInfo)`: unchanged name and callers; reads
    `traitOf(runtimeInfo, "approvals", "shellLevels").includes("every")`.
  - `modelsFor(models, runtimeInfo)` and `imagesFor(models, runtimeInfo)`: the second
    argument is now the runtime view; both branch on
    `traitOf(runtimeInfo, "models", "chatgptLogin") === "agentpierHeld"`.

- [ ] **Step 1: Write the failing tests**

```js
import { DEFAULT_TRAITS } from "../../server/features/assistants/runtimes/runtime-traits.js";
import { traitDefaults, traitOf } from "../../web/features/assistants/runtime-traits.js";

test("the web defaults are the server's", () => {
  assert.deepEqual(traitDefaults, DEFAULT_TRAITS);
});

test("traitOf reads the view and falls back to the default", () => {
  const info = {
    capabilities: { channelBots: { available: true, peopleApply: "restart" } },
  };
  assert.equal(traitOf(info, "channelBots", "peopleApply"), "restart");
  assert.equal(traitOf(info, "sessions", "chatFolders"), false);
  assert.equal(traitOf(undefined, "channelBots", "peopleApply"), "live");
  assert.equal(traitOf({ capabilities: {} }, "host", "process"), "shared");
});
```

In `hermes-runtime-web.test.js`, replace the two fixtures (lines 37 and 43) by views
whose `capabilities.approvals.shellLevels` has and lacks `"every"`, and call
`modelsFor(models, hermesInfo)` / `modelsFor(models, openClawInfo)` with
`capabilities.models.chatgptLogin` set; keep every expected value. In
`hermes-images.test.js` pass runtime views to `imagesFor` the same way.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/unit/runtime-traits-web.test.js tests/unit/hermes-runtime-web.test.js tests/unit/hermes-images.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** the helper and the two changed functions, and update the
      callers in `ProfileFields.jsx` (`assistant?.runtimeInfo`) and
      `CapabilitiesTab.jsx` (`assistant?.runtimeInfo`).

- [ ] **Step 4: Replace the remaining comparisons in the settings**
  - `CapabilityGroups.jsx:50`: `dreams` is
    `traitOf(assistant?.runtimeInfo, "agentFiles", "dreaming") === "host"`. The
    component is also used by the wizard, where there is no agent: add a
    `runtimeInfo` prop that wins over `assistant?.runtimeInfo` and drop the read of
    `draft.values.runtime` (Task 5 passes the prop).
  - `TelegramSendersSettings.jsx:15`: `restartsOnPeople(runtime)` is
    `traitOf(runtime, "channelBots", "peopleApply") === "restart"`.
  - If nothing reads `capabilityGateCopy.reasons.approvalAsksEveryCommand` any more
    (`git grep approvalAsksEveryCommand -- web server`), remove the key from both
    catalogs under `web/lib/i18n/` and run `npm run i18n:confirm`.

- [ ] **Step 5: Run unit tests and the browser spec**

Run: `node --test tests/unit/runtime-traits-web.test.js tests/unit/hermes-runtime-web.test.js tests/unit/hermes-images.test.js tests/unit/capability-gate.test.js`
Run: `npm run build` then `npx playwright test tests/browser/hermes-runtime.spec.js`
Expected: PASS. If the spec rewrites `docs/screenshots/pipeline-permissions.png`,
restore it with `git checkout -- docs/screenshots/pipeline-permissions.png`.

- [ ] **Step 6: Commit**

```bash
git add web tests
git commit -m "feat: read runtime traits in the agent settings"
```

---

### Task 5: The wizard

**Files:**

- Modify: `web/features/assistants/wizard/AgentWizard.jsx:241-248`,
  `web/features/assistants/wizard/wizard-draft.js:116-130`,
  `web/features/assistants/wizard/wizard-creation.js:60`,
  `web/features/assistants/wizard/StepCapabilities.jsx:68`
- Test: `tests/unit/hermes-runtime-web.test.js` (the `withRuntime` and creation cases)

**Interfaces:**

- Consumes: `useRuntimes()` → `infoOf(id)` (Task 3); `traitOf`, `offersEveryCommand`,
  `modelsFor`, `imagesFor` (Task 4).
- Produces:
  - `withRuntime(d, runtime, models, runtimeInfo)`: `runtimeInfo` is the chosen
    runtime's view. It turns `shell: "every"` into `"approval"` only when
    `runtimeInfo` is known and does not offer every command, and clears a ChatGPT
    connection only when `runtimeInfo` is known and needs a login AgentPier holds.
  - The creation body gets `shellFields(d.shell, every)` with
    `every = offersEveryCommand(infoOf(d.runtime))`.

`StepStart.jsx` (the runtime chooser and its two hard-wired rows) and
`AgentWizard.jsx`'s `runtimeShown` stay as they are: they need each runtime's install
state, which is step 2 of the spec.

- [ ] **Step 1: Write the failing tests** (replace the existing `withRuntime` cases)

```js
const hermesInfo = {
  id: "hermes",
  capabilities: {
    approvals: { shellLevels: ["off", "approval", "every", "full"] },
    models: { chatgptLogin: "agentpierHeld" },
  },
};
const openClawInfo = { id: "openclaw", capabilities: {} };
const kept = { id: "openclaw:a", holder: "openclaw" };

test("withRuntime follows the chosen runtime's traits", () => {
  const d = { shell: "every", connectionId: "openclaw:a", modelId: "m" };
  assert.deepEqual(withRuntime(d, "", [kept], openClawInfo), {
    runtime: "",
    shell: "approval",
  });
  assert.deepEqual(withRuntime(d, "hermes", [kept], hermesInfo), {
    runtime: "hermes",
    connectionId: "",
    modelId: "",
  });
});

test("withRuntime changes nothing while the runtime's traits are unknown", () => {
  const d = { shell: "every", connectionId: "openclaw:a", modelId: "m" };
  assert.deepEqual(withRuntime(d, "hermes", [kept], undefined), { runtime: "hermes" });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/unit/hermes-runtime-web.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement.** `AgentWizard.jsx` calls `useRuntimes()` once and passes
      `infoOf(d.runtime)` to `withRuntime`, `modelsFor`, `StepCapabilities`
      (`everyCommand`, `imagesFor`, and the `runtimeInfo` prop of Task 4's memory
      group) and to the creation body.

- [ ] **Step 4: Run the tests and the wizard's browser specs**

Run: `node --test tests/unit/hermes-runtime-web.test.js`
Run: `npx playwright test tests/browser/hermes-runtime.spec.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web tests
git commit -m "feat: read runtime traits in the agent wizard"
```

---

### Task 6: The rule

**Files:**

- Create: `tests/helpers/runtime-id-scan.js`
- Modify: `tests/unit/runtime-port-rules.test.js`

**Interfaces:**

- Produces, in `runtime-id-scan.js`:
  - `runtimeModuleDirectories = ["server/features/assistants/runtimes/", "web/features/assistants/runtimes/"]`
  - `productSources()`: every `.js`, `.mjs` and `.jsx` under `server/` and `web/`
    outside those directories and outside `server/lib/i18n/` and `web/lib/i18n/`,
    as `{ file, text }` with whole-line comments removed (reuse the approach of
    `runtime-port-scan.js`).
  - `runtimeIdLiterals(sources)`: `{ [file]: count }` of string literals that are
    exactly `hermes` or `openclaw` in single, double or backtick quotes.
  - `runtimeNamedFiles(sources)`: sorted files whose base name starts with `hermes-`
    or `openclaw-`.

- [ ] **Step 1: Write the scanner's own tests** (in `runtime-port-rules.test.js`)

```js
test("the id scanner finds literals, not prefixes or prose", () => {
  const found = runtimeIdLiterals([
    { file: "a.js", text: 'if (x === "hermes") y(`openclaw`);' },
    { file: "b.js", text: 'id.startsWith("openclaw:"); name = "Hermes Agent";' },
  ]);
  assert.deepEqual(found, { "a.js": 2 });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test tests/unit/runtime-port-rules.test.js`
Expected: FAIL, missing module.

- [ ] **Step 3: Implement the scanner.**

- [ ] **Step 4: Add the two rules with their allowlists.** Print what the scanners
      find on the tree as it is after Task 5 and write that into the test as
      `runtimeIdAllowlist` (`{ file: count }`) and `runtimeNamedFileAllowlist`
      (array). Both tests use `assert.deepEqual(found, allowlist, hint)`, so a new
      offender and a stale entry both fail. Head each list with the comment "This
      list may only shrink." Group the entries under one comment per reason:
  - permanent, `"openclaw"` as a login holder, proxy consumer or allowlist source
    (`model-accounts.js`, `model-account-move.js`, `mcp-oauth-holders.js`,
    `proxy-access.js`, `mcp-changes.js`, `application/assistant-graph.js`,
    `exec-allowlist.js`, `browser-upload-staging.js`, `ChatgptAccountDetail.jsx`,
    `McpOAuthLogin.jsx`, `McpOAuthStatus.jsx`);
  - spec step 2 (`wizard/StepStart.jsx`, `wizard/AgentWizard.jsx`);
  - spec step 3 (`hub/RuntimeHermesGroup.jsx` and the web `hermes-*` files);
  - spec step 4 (`advanced-config.js`);
  - spec step 5 (every other server file and the server `hermes-*` files).

- [ ] **Step 5: Pin what this step moved.** Add:

```js
test("the files step 1 moved name no runtime", () => {
  for (const file of [
    "web/features/assistants/shell-level.js",
    "web/features/assistants/runtime-capabilities.js",
    "web/features/assistants/TelegramSendersSettings.jsx",
    "web/features/assistants/settings/CapabilityGroups.jsx",
    "web/features/assistants/wizard/wizard-draft.js",
    "web/features/assistants/wizard/wizard-creation.js",
    "web/features/assistants/wizard/StepCapabilities.jsx",
    "server/features/assistants/chat-file-folders.js",
  ])
    assert.equal(Object.hasOwn(runtimeIdAllowlist, file), false, file);
});
```

      `runtime-capabilities.js` holds the product names by id (`runtimeNames`); move
      that lookup onto `runtimeInfo.name` and the runtime list (`infoOf(id)?.name`)
      so the file passes, keeping `runtimeIdName(id)` for its callers with the list
      as a second argument, or leave the file on the allowlist under "spec step 2"
      and take it out of this test. Choose the first if it touches at most the five
      importing files.

- [ ] **Step 6: Run the rule test**

Run: `node --test tests/unit/runtime-port-rules.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests
git commit -m "chore: forbid runtime ids outside the runtime modules"
```

---

### Task 7: Decision record, docs, full check

**Files:**

- Create: `docs/adr/0007-runtime-descriptor.md`
- Modify: `docs/adr/0006-assistant-runtime-port.md` (one line under "Every port also
  exposes `capabilities()`" pointing to ADR 0007), `docs/architecture.md` and
  `docs/hermes-runtime.md` wherever they name `everyCommandApproval` or
  `capabilities()` (`git grep -n "everyCommandApproval\|capabilities()" -- docs`),
  `docs/README.md` if it lists the ADRs

- [ ] **Step 1: Write ADR 0007** in English, in the form of ADR 0006 (Status, Date,
      Context, Decision, Considered options, Consequences). Content: the three kinds
      (feature, trait, surface) and the rule from the spec's Design section; the
      three approaches and the choice from its Approaches section; status "accepted;
      step 1 (traits) implemented, surfaces and described options follow". Do not
      link to the spec: it is a working document and is deleted later.

- [ ] **Step 2: Update the docs found by the grep** so each names
      `approvals.shellLevels` and `GET /api/assistant-runtimes` where it described
      the old capability or the hard-wired wizard choice.

- [ ] **Step 3: Run the full check**

Run: `npm run check`
Expected: lint, format, structure, build and backend tests pass. `shell.test.js` may
fail for reasons of this machine's environment; any other failure is this change's.

- [ ] **Step 4: Run the affected browser specs**

Run: `npx playwright test tests/browser/hermes-runtime.spec.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "chore: record the runtime descriptor decision"
```

The spec and this plan stay in the branch until the pull request that completes the
spec's last step; the pull request for step 1 lists them as unfinished work tracked in
the spec's delivery order.
