import test from "node:test";
import assert from "node:assert/strict";
import { readRoute, routePath, crossLinkRoute } from "../../web/app/routes.js";
import {
  advancedKey,
  advancedRangeError,
  capacityError,
  runtimeServer,
  runtimeSteps,
} from "../../web/features/assistants/hub/runtime-draft.js";
import {
  agentPills,
  hubCounts,
  hubLists,
} from "../../web/features/assistants/hub/agent-rows.js";
import {
  activationPhase,
  subagentInstallRoute,
  templateAgentRoute,
} from "../../web/features/assistants/hub/hub-model.js";

const read = (path) => readRoute(new URL(path, "http://localhost"));

test("the Runtime tab's draft holds the switch, capacity, dreaming and advanced values", () => {
  assert.deepEqual(runtimeServer({ enabled: true }), { agentsEnabled: true });
  assert.deepEqual(
    runtimeServer({
      enabled: true,
      teamSettings: { hostMaxConcurrent: 8, revision: 3 },
      dreaming: { enabled: true, hour: 4, timeZone: "Europe/Berlin", revision: 2 },
      advanced: { settings: [{ id: "runTimeout", override: 900 }, { id: "x" }] },
    }),
    {
      agentsEnabled: true,
      hostMaxConcurrent: 8,
      dreamingEnabled: true,
      dreamingHour: 4,
      dreamingTimeZone: "Europe/Berlin",
      [advancedKey("runTimeout")]: 900,
      [advancedKey("x")]: "",
    },
  );
  assert.notEqual(capacityError({ hostMaxConcurrent: 2 }), "");
  assert.equal(capacityError({ hostMaxConcurrent: 8 }), "");
  const setting = { id: "runTimeout", type: "integer", minimum: 300, maximum: 604800 };
  assert.notEqual(advancedRangeError(setting, 60), "");
  assert.equal(advancedRangeError(setting, 900), "");
  assert.equal(advancedRangeError(setting, ""), "");
});

test("the Runtime save chain keeps every existing server call in order", async () => {
  const calls = [];
  const api = {
    teamSettings: async (body) => (calls.push(["team", body]), { revision: 4 }),
    saveDreaming: async (body) => (calls.push(["dreaming", body]), { revision: 3 }),
    saveAdvancedSetting: async (body) => (calls.push(["advanced", body]), {}),
  };
  const steps = runtimeSteps({
    api,
    setEnabled: async (enabled) => (calls.push(["feature", enabled]), { enabled }),
    refresh: { assistants: async () => {}, dreaming: async () => {} },
    settings: [
      {
        id: "runTimeout",
        path: "agents.defaults.timeoutSeconds",
        type: "integer",
        minimum: 300,
      },
    ],
  });
  assert.deepEqual(
    steps.map((s) => s.id),
    [
      "capacityRange",
      "advancedRanges",
      "feature",
      "capacity",
      "dreaming",
      "advanced-runTimeout",
    ],
  );
  const values = {
    agentsEnabled: false,
    hostMaxConcurrent: 6,
    dreamingEnabled: true,
    dreamingHour: 3,
    dreamingTimeZone: "UTC",
    [advancedKey("runTimeout")]: "",
  };
  await steps[2].run({ values });
  await steps[3].run({ values, revision: 1 });
  await steps[5].run({ values, confirmations: { confirmRestart: true } });
  assert.deepEqual(calls, [
    ["feature", false],
    ["team", { revision: 1, hostMaxConcurrent: 6 }],
    [
      "advanced",
      { path: "agents.defaults.timeoutSeconds", value: null, confirmRestart: true },
    ],
  ]);
  // A refused switch (agents could not start) fails its step.
  const refused = runtimeSteps({
    api,
    setEnabled: async () => ({ enabled: false, error: "X" }),
    refresh: { assistants: async () => {}, dreaming: async () => {} },
  });
  await assert.rejects(refused[2].run({ values: { agentsEnabled: true } }));
  // An out-of-range advanced value stops the chain before any request.
  assert.throws(() =>
    steps[1].run({
      values: { [advancedKey("runTimeout")]: 10 },
      changed: [advancedKey("runTimeout")],
    }),
  );
});

test("the hub lists agents, archived ones apart, and never temporary members", () => {
  const agents = [
    { id: "a" },
    { id: "b", userAccess: { mode: "own", members: [] } },
    { id: "c", teamMemberId: "m", lifetime: "task" },
    { id: "d", teamMemberId: "m2", lifetime: "permanent" },
    { id: "e", archivedAt: "2026-01-01", teamMemberId: "m3" },
  ];
  const lists = hubLists(agents);
  assert.deepEqual(
    lists.own.map((a) => a.id),
    ["a", "d"],
  );
  assert.deepEqual(
    lists.ofUsers.map((a) => a.id),
    ["b"],
  );
  assert.deepEqual(
    lists.archived.map((a) => a.id),
    ["e"],
  );
  assert.deepEqual(
    hubCounts({ assistants: agents, teams: [{}, { archivedAt: "x" }], templates: 142 }),
    { all: 3, teams: 1, templates: 142 },
  );
  assert.equal(hubCounts({ assistants: [], teams: [] }).templates, undefined);
});

test("agent pills summarise access and channels, never a made-up zero", () => {
  const policy = {
    projectIds: ["p1"],
    projectFiles: { p1: "read", p2: "write" },
    sshAccesses: [{}],
  };
  assert.deepEqual(agentPills({ mcpServers: ["m"] }, policy, true), [
    "2 Projekte",
    "1 MCP",
    "SSH 1",
    "Telegram",
  ]);
  // Unknown access shows only what the agent itself says.
  assert.deepEqual(agentPills({}, null, null), []);
  assert.deepEqual(agentPills({}, { projectIds: [] }, false), ["Keine Zugriffe"]);
});

test("activation progress follows the switch and the runtime", () => {
  assert.equal(activationPhase({ saving: true }), "switching");
  assert.equal(
    activationPhase({ enabled: true, availability: "installing" }),
    "installing",
  );
  assert.equal(activationPhase({ enabled: true, availability: "starting" }), "starting");
  assert.equal(activationPhase({ enabled: true, availability: "ready" }), null);
  assert.equal(activationPhase({ enabled: false, availability: "installing" }), null);
});

test("template actions lead to the wizard and to Coding › Unteragenten", () => {
  const entry = { id: "engineering__sre", revision: "a".repeat(40) };
  assert.equal(
    routePath(templateAgentRoute(entry)),
    `/agents?new=1&template=engineering__sre&revision=${"a".repeat(40)}`,
  );
  const install = subagentInstallRoute(entry);
  assert.equal(install.extensionTab, "subagents");
  assert.equal(install.install, "engineering__sre");
  // Coding's routes keep the entry, so the install preview opens there.
  assert.equal(
    routePath(install),
    "/coding/clis/extensions?tab=subagents&install=engineering__sre",
  );
  assert.equal(read(routePath(install)).install, "engineering__sre");
});

test("Runtime links scroll to the advanced values or the storage cleanup", () => {
  for (const section of ["advanced", "storage"]) {
    const path = `/agents?tab=runtime&section=${section}`;
    assert.equal(read(path).agentsSection, section);
    assert.equal(routePath(read(path)), path);
  }
  assert.equal(read("/agents?tab=runtime&section=other").agentsSection, undefined);
  assert.equal(read("/agents?tab=teams&section=storage").agentsSection, undefined);
});

test("only the Runtime tab of the hub keeps a cross-link's origin", () => {
  const origin = read("/agents/home/settings");
  const runtime = crossLinkRoute({ view: "agents", agentsTab: "runtime" }, origin);
  assert.equal(
    routePath(runtime),
    "/agents?tab=runtime&returnTo=%2Fagents%2Fhome%2Fsettings",
  );
  assert.equal(read(routePath(runtime)).returnTo, "/agents/home/settings");
  assert.equal(
    crossLinkRoute({ view: "agents", agentsTab: "teams" }, origin).returnTo,
    undefined,
  );
});
