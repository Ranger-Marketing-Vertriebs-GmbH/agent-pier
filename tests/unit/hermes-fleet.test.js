import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hermesFakeRuntime, eventually } from "../helpers/hermes-fake-runtime.js";
import { contractAgent } from "../helpers/hermes-native.js";
import { HermesFleet } from "../../server/features/assistants/runtimes/hermes/hermes-fleet.js";
import {
  attachHermesFleet,
  hermesAvailable,
  hostReady,
  ownProcess,
  runtimeAccepts,
  runtimeFor,
  runtimeForSession,
} from "../../server/features/assistants/runtimes/runtime-for.js";

const hermesAgent = (id, extra = {}) => ({
  id,
  runtime: "hermes",
  runtimeAgentId: `ap-${id}`,
  ...extra,
});

function fleet(t, fake, options = {}) {
  const made = new HermesFleet({
    dataDir: fake.dataDir,
    available: () => true,
    runtime: async () => fake.runtime,
    stopTimeoutMs: 3000,
    ...options,
  });
  t.after(() => made.close());
  return made;
}

test("the fleet keeps one runtime per Hermes agent and starts only available, active ones", async (t) => {
  const fake = hermesFakeRuntime(t);
  let available = false;
  const sets = fleet(t, fake, { available: () => available });
  const a = hermesAgent("a"),
    b = hermesAgent("b", { archivedAt: "2026-11-01T00:00:00Z" });
  assert.equal(sets.runtimeOf(a), sets.runtimeOf("ap-a"));
  assert.notEqual(sets.runtimeOf(a), sets.runtimeOf(hermesAgent("c")));
  // Hermes not enabled or installed: nothing starts.
  assert.equal(await sets.start(a), null);
  assert.equal(sets.runtimeOf(a).host.status().availability, "disabled");
  available = true;
  // OpenClaw agents and archived Hermes agents never start here.
  assert.equal(await sets.startAll([a, b, { id: "o", runtime: "openclaw" }]), 0);
  assert.equal(sets.runtimeOf(a).host.ready(), true);
  assert.equal(sets.runtimeOf(b).host.status().availability, "disabled");
  assert.equal(sets.running(), true);
  await sets.stopAll();
  assert.equal(sets.running(), false);
  assert.throws(() => sets.runtimeOf({ runtime: "hermes", runtimeAgentId: "../x" }), {
    code: "HERMES_AGENT_ID",
  });
});

test("events of every set reach one subscription, across a restart", async (t) => {
  const fake = hermesFakeRuntime(t);
  const sets = fleet(t, fake);
  const seen = [];
  const statuses = [];
  sets.on("status", (agentId, status) => statuses.push([agentId, status.availability]));
  const unsubscribe = sets.subscribe((event) => seen.push(event));
  const a = hermesAgent("a");
  await sets.start(a);
  const first = sets.runtimeOf(a).host.connection();
  await sets.runtimeOf(a).host.restart();
  const second = sets.runtimeOf(a).host.connection();
  assert.notEqual(first, second);
  // The subscription follows the new connection.
  assert.ok(statuses.some(([id, s]) => id === "ap-a" && s === "ready"));
  unsubscribe();
  assert.equal(sets.listeners.size, 0);
  assert.deepEqual(seen, []);
});

test("config.apply writes the agent's home, starts the set and restarts it on a change", async (t) => {
  const fake = hermesFakeRuntime(t);
  let strict = false;
  const sets = fleet(t, fake, { strict: () => strict });
  const agent = hermesAgent("a");
  const runtime = sets.runtimeOf(agent);
  const desired = contractAgent("ap-a", { baseUrl: "http://127.0.0.1:9/v1" });
  await runtime.config.apply({ desired });
  assert.equal(runtime.host.ready(), true);
  assert.equal(fake.starts("ap-a").length, 1);
  const config = path.join(fake.home("ap-a"), "config.yaml");
  assert.match(fs.readFileSync(config, "utf8"), /base_url: http:\/\/127\.0\.0\.1:9\/v1/);
  // Unchanged: no restart.
  assert.deepEqual(await runtime.config.apply({ desired }), {
    written: [],
    restarted: false,
  });
  assert.equal(fake.starts("ap-a").length, 1);
  // Every command: the guard plugin is written and the set restarts once.
  strict = true;
  const changed = await runtime.config.apply({ desired, strict: true });
  assert.equal(changed.restarted, true);
  assert.ok(changed.written.some((file) => file.includes("agentpier-guard")));
  await eventually(() => fake.starts("ap-a").length === 2, 10000, "the restart");
  // The next start keeps the strict home it applied last.
  await runtime.host.restart();
  assert.ok(fs.existsSync(path.join(fake.home("ap-a"), "plugins/agentpier-guard")));
});

test("a new team bridge reaches the team plugin without a restart", async (t) => {
  const fake = hermesFakeRuntime(t);
  const sets = fleet(t, fake);
  const runtime = sets.runtimeOf(hermesAgent("lead"));
  const desired = contractAgent("ap-lead", { baseUrl: "http://127.0.0.1:9/v1" });
  const bridge = (token) => ({ url: "http://127.0.0.1:4100", token });
  await runtime.config.apply({ desired, connection: bridge("first") });
  const plugin = path.join(fake.home("ap-lead"), "plugins/agentpier-team");
  assert.match(
    fs.readFileSync(path.join(plugin, "tools.json"), "utf8"),
    /agentpier_team_propose/,
  );
  assert.equal(fake.starts("ap-lead").length, 1);
  // AgentPier restarted: a new token, read by the plugin at its next call.
  const next = await runtime.config.apply({ desired, connection: bridge("second") });
  assert.deepEqual(next, {
    written: ["plugins/agentpier-team/bridge.json"],
    restarted: false,
  });
  assert.equal(fake.starts("ap-lead").length, 1);
  assert.match(fs.readFileSync(path.join(plugin, "bridge.json"), "utf8"), /"second"/);
  // Without the bridge the plugin goes, and the set restarts without it.
  const gone = await runtime.config.apply({ desired });
  assert.equal(gone.restarted, true);
  assert.equal(fs.existsSync(plugin), false);
});

test("removing an agent stops its set and deletes its Hermes folders", async (t) => {
  const fake = hermesFakeRuntime(t);
  const sets = fleet(t, fake);
  const agent = hermesAgent("gone");
  await sets.start(agent);
  const paths = sets.runtimeOf(agent).host;
  assert.equal(paths.ready(), true);
  const root = path.join(fake.dataDir, "assistants/hermes");
  for (const name of ["home", "state"])
    assert.equal(fs.existsSync(path.join(root, name, "ap-gone")), true, name);
  // It works in AgentPier's own agent workspace, as an OpenClaw agent does.
  const work = path.join(fake.dataDir, "assistants/workspaces/gone");
  assert.equal(fs.existsSync(work), true);
  assert.equal(sets.workspaceOf(agent), work);
  await sets.remove(agent);
  for (const name of ["home", "state", "workspaces", "tmp", "logs"])
    assert.equal(fs.existsSync(path.join(root, name, "ap-gone")), false, name);
  assert.equal(fs.existsSync(work), false);
  assert.equal(sets.known("ap-gone"), null);
});

test("runtime-for resolves Hermes agents and their sessions through the attached fleet", async (t) => {
  const fake = hermesFakeRuntime(t);
  const supervisor = { client: { ready: true }, status: () => ({}) };
  // Without a fleet: Hermes agents are known but unavailable.
  assert.equal(hermesAvailable(supervisor), false);
  const idle = runtimeFor(hermesAgent("x"), supervisor);
  assert.equal(idle.id, "hermes");
  assert.equal(idle.host.ready(), false);
  const owner = { client: { ready: true }, status: () => ({}) };
  const sets = attachHermesFleet(owner, fleet(t, fake, { available: () => true }));
  const agent = hermesAgent("s");
  assert.equal(ownProcess(agent), true);
  assert.equal(ownProcess({ runtime: "openclaw" }), false);
  assert.equal(hermesAvailable(owner), true);
  // A Hermes agent may take changes while Hermes is available; its set starts then.
  assert.equal(runtimeAccepts(owner, agent), true);
  assert.equal(hostReady(owner, agent), false);
  await sets.start(agent);
  assert.equal(hostReady(owner, agent), true);
  assert.equal(runtimeForSession("agent:ap-s:hermes:abc", owner), sets.runtimeOf(agent));
  assert.equal(runtimeForSession("agent:ap-s:main", owner).id, "openclaw");
  assert.equal(runtimeForSession(null, owner).id, "openclaw");
});
