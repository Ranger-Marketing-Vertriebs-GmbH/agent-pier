import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ownProcessWiring,
  runtimeRouters,
  startRuntimes,
  wireAgentHosts,
  wireRuntimes,
} from "../../server/features/assistants/runtimes/runtime-wiring.js";
import {
  agentDreams,
  dreamDiary,
  generatedImages,
  runtimeToolRoutes,
} from "../../server/features/assistants/runtimes/runtime-services.js";
import {
  isPrivateRuntimeTree,
  isRuntimeBrowserTree,
  isRuntimeCredential,
  isRuntimeExcluded,
  isRuntimeSnapshotCredential,
  runtimeBrowserProfiles,
} from "../../server/features/assistants/runtimes/runtime-backup-paths.js";
import {
  agentHostSets,
  agentHosts,
  agentPrivateFolders,
  agentWorkspace,
  assertRuntimeReady,
  attachAgentHosts,
  ownHostSessionKey,
  ownProcess,
  runtimeReady,
  sharedHostAgents,
} from "../../server/features/assistants/runtimes/runtime-for.js";
import { startAssistantServices } from "../../server/application/assistants.js";
import { hermesDescriptor } from "../../server/features/assistants/runtimes/hermes/descriptor.js";
import { HermesFleet } from "../../server/features/assistants/runtimes/hermes/hermes-fleet.js";
import { hermesFleetOf } from "../../server/features/assistants/runtimes/hermes/hermes-hosts.js";
import { hermesGuard } from "../../server/features/assistants/runtimes/hermes/tools/hermes-tool-guard.js";
import { hermesBrowserUpload } from "../../server/features/assistants/runtimes/hermes/tools/hermes-browser-upload.js";
import { hermesRoutineApproval } from "../../server/features/assistants/runtimes/hermes/tools/hermes-routine-approvals.js";
import {
  browserRefusals,
  writeRefusals,
} from "../../server/features/assistants/team-plugin/tool-guard.js";
import {
  toolPolicy,
  toolPolicyRoutes,
} from "../../server/features/assistants/bridge-tool-policies.js";

// ADR 0007, decision 7: a runtime's own services live in its adapter. The composition
// roots wire them through runtime-wiring.js, feature code reaches a runtime's parts of
// shared features through runtime-services.js and runtime-backup-paths.js, and the
// port's helpers ask the agent's runtime instead of naming one.

const hermes = hermesDescriptor.id;
const temporary = (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-wiring-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};
const routesOf = (router) =>
  router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map(
        (method) => `${method.toUpperCase()} ${layer.route.path}`,
      ),
    );

test("wireRuntimes merges each runtime's wiring onto the services, in registry order", (t) => {
  const signaled = [];
  const services = { live: { invalidate: (topic) => signaled.push(topic) } };
  const wired = wireRuntimes(services, { config: { dataDir: temporary(t) } });
  // The switch first, then the generic entries: the order the application kept.
  assert.deepEqual(Object.keys(services), [
    "live",
    "hermesRuntime",
    "runtimeInstalls",
    "runtimeWiring",
  ]);
  assert.equal(services.hermesRuntime, wired.services.hermesRuntime);
  assert.deepEqual(Object.keys(services.runtimeInstalls), [hermes]);
  assert.equal(services.runtimeInstalls, wired.installs);
  assert.equal(services.runtimeInstalls[hermes]().enabled, false);
  assert.equal(services.runtimeWiring.routes.length, 1);
  assert.equal(services.runtimeWiring.listening.length, 1);
  // Every change of the switch reaches the live topic.
  services.hermesRuntime.onChange();
  assert.deepEqual(signaled, ["runtimes"]);
});

test("what the wiring returns reads the switch at each call", (t) => {
  const services = {};
  wireRuntimes(services, { config: { dataDir: temporary(t) } });
  const calls = [];
  // A switch put on the services later (a test's, a replaced one) is the one used.
  services.hermesRuntime = {
    state: () => ({ enabled: true, installed: true }),
    start: () => calls.push("start"),
  };
  assert.deepEqual(services.runtimeInstalls[hermes](), {
    enabled: true,
    installed: true,
  });
  startRuntimes(services);
  assert.deepEqual(calls, ["start"]);
  // Without a switch nothing starts, and no wiring at all starts nothing.
  delete services.hermesRuntime;
  assert.deepEqual(startRuntimes(services), [undefined]);
  assert.deepEqual(startRuntimes({}), []);
  assert.deepEqual(runtimeRouters({}), []);
});

test("the runtime routers are Hermes's four owner routes, and none without its switch", (t) => {
  const services = { audit: { append: () => {} } };
  wireRuntimes(services, { config: { dataDir: temporary(t) } });
  const [router, ...more] = runtimeRouters(services);
  assert.deepEqual(more, []);
  assert.deepEqual(routesOf(router), [
    "GET /assistant-runtime/hermes",
    "PUT /assistant-runtime/hermes",
    "GET /assistant-runtime/hermes/update/blockers",
    "POST /assistant-runtime/hermes/update",
  ]);
  delete services.hermesRuntime;
  assert.deepEqual(routesOf(runtimeRouters(services)[0]), []);
});

test("the Hermes routes audit under the descriptor's id", async (t) => {
  const records = [];
  const services = { audit: { append: (record) => records.push(record) } };
  wireRuntimes(services, { config: { dataDir: temporary(t) } });
  services.hermesRuntime = {
    state: () => ({ enabled: false }),
    disable: async () => ({ enabled: false }),
  };
  const [router] = runtimeRouters(services);
  const put = router.stack.find(
    (layer) =>
      layer.route?.path === "/assistant-runtime/hermes" && layer.route.methods.put,
  );
  let answered;
  await put.route.stack[0].handle(
    { body: { enabled: false } },
    { json: (body) => (answered = body) },
  );
  assert.deepEqual(answered, { enabled: false });
  assert.equal(records.length, 1);
  assert.equal(records[0].resourceId, hermes);
  assert.equal(records[0].resourceId, "hermes");
  assert.deepEqual(records[0].details, { enabled: false });
});

test("wireAgentHosts attaches a fleet per graph; ownProcessWiring answers by the agent's runtime", async (t) => {
  const supervisor = {};
  const dataDir = temporary(t);
  wireAgentHosts(supervisor, {
    dataDir,
    store: { listAssistants: () => [], db: null },
    created: {},
  });
  const fleet = hermesFleetOf(supervisor);
  assert.ok(fleet instanceof HermesFleet);
  assert.equal(fleet.dataDir, dataDir);
  assert.deepEqual(agentHostSets(supervisor), [fleet]);
  const bridge = { start: async () => ({ url: "http://127.0.0.1:1", token: "t" }) };
  const { hostInputs, ...rest } = ownProcessWiring({ bridge });
  assert.deepEqual(rest, {});
  const inputs = await hostInputs({ runtime: hermes, runtimeAgentId: "ap-h" });
  assert.deepEqual(inputs.connection, { url: "http://127.0.0.1:1", token: "t" });
  assert.equal(inputs.modelProxy, null);
  // An agent on the shared host, or of a runtime this AgentPier lacks, reads none.
  assert.equal(await hostInputs({ runtime: "openclaw" }), undefined);
  assert.equal(await hostInputs({ runtime: "later" }), undefined);
  assert.equal(await hostInputs({ runtime: "constructor" }), undefined);
});

test("the neutral helpers ask the agent's runtime", () => {
  const h = { id: "h", runtime: hermes, runtimeAgentId: "ap-h" };
  const shared = { id: "o", runtime: "openclaw", runtimeAgentId: "ap-o" };
  const unknown = { id: "u", runtime: "later", runtimeAgentId: "ap-u" };
  assert.equal(ownProcess(h), true);
  for (const agent of [shared, unknown, null, {}]) assert.equal(ownProcess(agent), false);
  assert.deepEqual(sharedHostAgents([h, shared, unknown, { id: "d" }]), [
    shared,
    { id: "d" },
  ]);
  const supervisor = {};
  // No agent hosts for an agent on the shared host, an unknown runtime, no supervisor.
  for (const agent of [shared, unknown, null]) {
    assert.equal(agentHosts(supervisor, agent), null);
    assert.equal(agentWorkspace(supervisor, agent), null);
    assert.equal(agentPrivateFolders(supervisor, agent), null);
  }
  assert.equal(agentHosts(null, h), null);
  assert.equal(agentWorkspace(null, h), null);
  // Before any were attached: not ready, and asking makes none.
  assert.equal(runtimeReady(supervisor, h), false);
  assert.equal(runtimeReady(null, h), false);
  for (const agent of [shared, unknown, null]) {
    assert.equal(runtimeReady(supervisor, agent), true);
    assert.equal(runtimeReady(null, agent), true);
    assertRuntimeReady(supervisor, agent);
  }
  assert.throws(() => assertRuntimeReady(supervisor, h), {
    key: "hermesUnavailable",
    status: 409,
  });
  // Idle hosts at the first use: they never start and are not available.
  const idle = agentHosts(supervisor, h);
  assert.ok(idle instanceof HermesFleet);
  assert.equal(idle.dataDir, null);
  assert.equal(agentHosts(supervisor, h), idle);
  assert.equal(runtimeReady(supervisor, h), false);
  assert.equal(agentWorkspace(supervisor, h), null);
  // Attached hosts answer.
  const owner = {};
  const hosts = attachAgentHosts(owner, hermes, {
    available: () => true,
    workspaceOf: (agent) => `/w/${agent.id}`,
    privateFoldersOf: (agent) => [`/p/${agent.id}`],
  });
  assert.equal(agentHosts(owner, h), hosts);
  assert.equal(runtimeReady(owner, h), true);
  assertRuntimeReady(owner, h);
  assert.equal(agentWorkspace(owner, h), "/w/h");
  assert.deepEqual(agentPrivateFolders(owner, h), ["/p/h"]);
  assert.throws(() => attachAgentHosts(owner, "later", {}), { key: "runtimeUnknown" });
});

test("the bridge's tool routes are the runtimes' own and AgentPier's policies, as before", async () => {
  assert.deepEqual(toolPolicyRoutes(), [
    "/hermes-guard",
    "/hermes-approval",
    "/hermes-browser-upload",
    "/image-policy",
    "/pdf-policy",
  ]);
  const routes = runtimeToolRoutes();
  assert.equal(routes["/hermes-guard"].answer, hermesGuard);
  assert.equal(routes["/hermes-approval"].answer, hermesRoutineApproval);
  assert.equal(routes["/hermes-browser-upload"].answer, hermesBrowserUpload);
  // A closed bridge refuses each without asking the runtime.
  const closed = { closed: true, assistants: {} };
  assert.deepEqual(toolPolicy(closed, "/hermes-guard", {}), { allow: false });
  assert.deepEqual(toolPolicy(closed, "/hermes-approval", {}), { allow: false });
  assert.deepEqual(toolPolicy(closed, "/hermes-browser-upload", {}), {
    ok: false,
    message: "AgentPier is not reachable right now; try again shortly.",
  });
  assert.deepEqual(toolPolicy(closed, "/image-policy", {}), {
    allow: false,
    reason: "unavailable",
  });
  // An open one asks the service of the same name, or refuses without it.
  const open = { closed: false, assistants: { pdfPolicy: { check: (input) => input } } };
  assert.deepEqual(toolPolicy(open, "/pdf-policy", { a: 1 }), { a: 1 });
  assert.deepEqual(toolPolicy(open, "/image-policy", {}), {
    allow: false,
    reason: "unavailable",
  });
  assert.deepEqual(toolPolicy(open, "/other", {}), {
    allow: false,
    reason: "unavailable",
  });
  // An open bridge hands a runtime's route to that runtime: an invalid call throws.
  await assert.rejects(async () => toolPolicy(open, "/hermes-guard", null), {
    key: "invalid",
  });
});

// The two entry checks that are authorization checks stay as strict in the adapter.
test("Hermes's guard and browser upload refuse an agent of another or an unknown runtime", async () => {
  const agents = {
    "ap-o": { id: "o", runtime: "openclaw", runtimeAgentId: "ap-o" },
    "ap-d": { id: "d", runtimeAgentId: "ap-d" },
    "ap-u": { id: "u", runtime: "later", runtimeAgentId: "ap-u" },
  };
  const calls = [];
  const record = (name) => async (input) => {
    calls.push([name, input]);
    return { allow: true };
  };
  const bridge = {
    closed: false,
    assistants: { runtime: {} },
    agentOf: (id) => agents[id] ?? null,
    toolPolicy: record("tool"),
    browserPolicy: record("browser"),
    callingChat: () => ({}),
  };
  for (const agentId of ["ap-o", "ap-d", "ap-u", "ap-none"]) {
    for (const [toolName, args] of [
      ["write_file", { path: "notes.txt", content: "x" }],
      ["read_file", { path: "notes.txt" }],
      ["browser_navigate", { url: "https://example.org" }],
      ["image_generate", { prompt: "x" }],
      ["pdf", { path: "a.pdf" }],
    ])
      assert.deepEqual(
        await hermesGuard(bridge, {
          agentId,
          sessionKey: `agent:${agentId}:hermes:s1`,
          toolName,
          args,
          memberWrite: true,
        }),
        { allow: false, message: writeRefusals.unauthorized },
        `${agentId} ${toolName}`,
      );
    assert.deepEqual(
      await hermesBrowserUpload(bridge, { agentId, paths: ["/up/x/report.txt"] }),
      { ok: false, message: browserRefusals.unavailable },
      agentId,
    );
  }
  // Neither asked a policy, the browser or a file for them.
  assert.deepEqual(calls, []);
});

test("the runtimes' parts of shared features are reached without naming one", async () => {
  // Dreams: made with the store in the dreaming settings' database.
  assert.equal(dreamDiary.listing(undefined, "a"), null);
  assert.equal(dreamDiary.note(undefined, "a"), null);
  const diary = { entries: [{ night: "2026-11-08" }], size: 10, modifiedAt: "x" };
  const store = { diary: (id) => (id === "a" ? diary : null) };
  assert.deepEqual(dreamDiary.listing(store, "a"), {
    name: "DREAMS.md",
    diary: true,
    size: 10,
    modifiedAt: "x",
  });
  assert.equal(dreamDiary.note(store, "a").readOnly, true);
  assert.equal(dreamDiary.note(store, "b"), null);
  assert.equal(typeof agentDreams, "function");
  // Generated images: a folder without a key, or another file, is left alone.
  const entry = { isFile: () => true, name: "report.txt" };
  assert.equal(
    await generatedImages.dropExpired({ key: "c1" }, entry, Date.now()),
    false,
  );
  await assert.rejects(
    generatedImages.keep({ runtime: {} }, { runtime: "openclaw" }, { id: "c" }, "a.png"),
    { key: "invalid" },
  );
  // Backup paths: Hermes's private folder below assistants/.
  assert.equal(isRuntimeExcluded("hermes/runtimes/0.1/bin"), true);
  assert.equal(isRuntimeExcluded("hermes/state/ap-a/config.yaml"), false);
  assert.equal(isRuntimeBrowserTree("hermes/home/ap-a/agentpier-browser/x"), true);
  assert.equal(isRuntimeBrowserTree("workspaces/a/x"), false);
  assert.equal(isPrivateRuntimeTree("hermes/home/ap-a/notes.txt"), true);
  assert.equal(isPrivateRuntimeTree("hermes/state/ap-a/config.yaml"), false);
  assert.equal(isPrivateRuntimeTree("workspaces/a/x"), false);
  // Credentials of a home, below assistants/ and below the runtime's own folder.
  assert.equal(isRuntimeCredential("hermes/state/ap-a/.env"), true);
  assert.equal(isRuntimeCredential("hermes/state/ap-a/auth.json"), true);
  assert.equal(isRuntimeCredential("hermes/state/ap-a/.env.bak"), false);
  assert.equal(isRuntimeCredential("state/credentials/x"), false);
  assert.equal(isRuntimeSnapshotCredential("state/ap-a/.env.bak"), true);
  assert.equal(isRuntimeSnapshotCredential("state/ap-a/backups/1/.env"), true);
  assert.equal(isRuntimeSnapshotCredential("state/ap-a/config.yaml"), false);
  // Browser profiles in the agents' own homes.
  const [profiles, ...others] = runtimeBrowserProfiles();
  assert.deepEqual(others, []);
  assert.equal(profiles.prefix, "assistants/hermes/home");
  assert.equal(profiles.folder, "agentpier-browser");
  assert.equal(profiles.homeOf("a1"), "ap-a1");
  assert.equal(profiles.homeOf("../x"), null);
  assert.equal(
    profiles.member("assistants/hermes/home/ap-a1/agentpier-browser/user-data/Default/x"),
    true,
  );
  assert.equal(profiles.member("assistants/hermes/home/ap-a1/notes.txt"), false);
});

test("a session key tells whether its agent ran on a host of its own", () => {
  assert.equal(ownHostSessionKey("agent:ap-a1:hermes:s1"), true);
  assert.equal(ownHostSessionKey("agent:ap-a1:hermes:cron:j:1"), true);
  for (const key of [
    "agent:ap-a1:main",
    "agent::hermes:s1",
    "x:agent:a:hermes:",
    "",
    null,
  ])
    assert.equal(ownHostSessionKey(key), false, String(key));
});

// The order of the agent services' start, as it was before the runtimes were wired
// through the port (recorded with the same probe on the commit before): the shared
// host first when its switch is on, then the agents' own hosts when some agent has
// one, whatever the shared host's switch says.
test("the agent services start the shared host, then the agents' own hosts", async (t) => {
  for (const own of [true, false])
    for (const enabled of [true, false]) {
      const log = [];
      const root = temporary(t);
      fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ enabled }));
      const supervisor = {
        paths: { root },
        status: () => ({}),
        client: null,
        start: async () => log.push("sharedHost.start"),
      };
      attachAgentHosts(supervisor, hermes, {
        startAll: async (agents) => log.push(`agentHosts.startAll(${agents.length})`),
      });
      const agents = [{ id: "o", runtime: "openclaw" }];
      if (own) agents.push({ id: "h", runtime: hermes }, { id: "u", runtime: "later" });
      startAssistantServices(
        {
          config: { dataDir: root },
          assistants: { store: { listAssistants: () => agents } },
          assistantUpdates: { status: () => ({}) },
          assistantRuntime: supervisor,
          assistantChannels: { start: () => log.push("channels.start") },
          assistantDreaming: { backups: { start: () => log.push("dreamBackups.start") } },
          assistantAgentSecrets: { syncAll: async () => log.push("secrets.syncAll") },
          assistantAgentSsh: null,
        },
        { stageInBackground: () => log.push("stageInBackground") },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        log,
        [
          "secrets.syncAll",
          "channels.start",
          "dreamBackups.start",
          enabled && "sharedHost.start",
          own && "agentHosts.startAll(3)",
          "stageInBackground",
        ].filter(Boolean),
        `own=${own} enabled=${enabled}`,
      );
    }
});
