import test from "node:test";
import assert from "node:assert/strict";
import { mcpStartSnapshot } from "../../server/features/assistants/openclaw-config/mcp-servers.js";
import { TeamMcpBindings } from "../../server/features/assistants/team-mcp.js";
import { mcpApplyFixture } from "../helpers/mcp-apply-fixture.js";

function setup(t) {
  let now = 0;
  const warnings = [];
  const f = mcpApplyFixture(t, {
    now: () => now,
    warn: (line) => warnings.push(line),
  });
  // A native Gateway started without MCP servers.
  f.runtime.mcp = mcpStartSnapshot({ profiles: [], mcp: {} }, () => {});
  // The team scheduler's tick, without any team member.
  const tick = new TeamMcpBindings({
    teams: { members: () => [] },
    assistants: f.service,
  });
  return {
    ...f,
    warnings,
    clock: (value) => (now = value),
    tick: () => tick.refresh(),
    failPatches(count) {
      const call = f.gateway.client.call;
      let left = count;
      f.gateway.client.call = async (method, params) => {
        if (method === "config.patch" && left-- > 0)
          throw Object.assign(Error("busy"), { code: "UNAVAILABLE", answered: true });
        return call(method, params);
      };
    },
  };
}

test("a failed patch stays pending and a later tick applies it with backoff", async (t) => {
  const f = setup(t);
  const home = f.agent("Home");
  const docs = f.http();
  f.failPatches(3);
  const changed = [];
  f.service.changed = () => changed.push(true);
  // The save is stored: only the live apply fails, so the answer is a pending success.
  const saved = await f.service.update(home.id, { mcpServers: [docs.id] }, 1);
  assert.equal(saved.pending, true);
  assert.deepEqual(saved.mcpServers, [docs.id]);
  assert.equal(changed.length, 1);
  assert.equal(f.changes.pending, true);
  assert.deepEqual(f.gateway.patches, []);
  // Backoff: 1 s, then 2 s, then 4 s after each further failure.
  const delays = [];
  for (const at of [0, 1000, 3000]) {
    f.clock(at);
    await f.tick().catch(() => {});
    delays.push(f.changes.retryAt - at);
  }
  // The tick before the first delay elapsed did not retry.
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.deepEqual(f.gateway.patches, []);
  f.clock(7000);
  await f.tick();
  assert.equal(f.gateway.patches.length, 1);
  assert.equal(f.changes.pending, false);
  assert.deepEqual(f.applied, [home.id]);
  assert.deepEqual(f.runtime.mcp.agentTools, { [home.runtimeAgentId]: ["docs__*"] });
  // One name-only diagnostic for the whole failure streak.
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /UNAVAILABLE/);
  assert.ok(!f.warnings[0].includes("secret") && !f.warnings[0].includes("docs"));
  // A settled store applies nothing further.
  await f.tick();
  assert.equal(f.gateway.patches.length, 1);
});

test("backoff is capped at one minute", async (t) => {
  const f = setup(t);
  for (let n = 0; n < 10; n++) f.changes.failed({ code: "X" });
  assert.equal(f.changes.retryAt, 60000);
  f.changes.ready();
  assert.equal(f.changes.due(), true);
});

test("an unreadable store never removes live servers", async (t) => {
  const f = setup(t);
  const home = f.agent("Home");
  const docs = f.http();
  await f.service.update(home.id, { mcpServers: [docs.id] }, 1);
  assert.equal(f.gateway.patches.length, 1);
  const signature = f.runtime.mcp.signature;
  const definitions = f.servers.definitions;
  f.servers.definitions = () => {
    throw Error("SQLITE_IOERR");
  };
  assert.equal(await f.changes.apply(), false);
  assert.equal(f.gateway.patches.length, 1);
  assert.deepEqual(Object.keys(f.gateway.config.mcp.servers), ["docs"]);
  assert.equal(f.runtime.mcp.signature, signature);
  assert.equal(f.changes.pending, true);
  assert.match(f.warnings[0], /MCP_STORE_UNREADABLE/);
  // Readable again: the pending apply finds nothing to change and settles.
  f.servers.definitions = definitions;
  f.clock(1000);
  await f.tick();
  assert.equal(f.gateway.patches.length, 1);
  assert.equal(f.changes.pending, false);
});

test("an agent whose re-apply failed is re-applied although the signature is equal", async (t) => {
  const f = setup(t);
  const home = f.agent("Home");
  const docs = f.http();
  const apply = f.service.config.apply;
  f.service.config.apply = async () => {
    throw Error("lost");
  };
  const saved = await f.service.update(home.id, { mcpServers: [docs.id] }, 1);
  assert.equal(saved.pending, true);
  assert.equal(f.gateway.patches.length, 1);
  assert.equal(f.changes.pending, true);
  f.service.config.apply = apply;
  f.clock(1000);
  await f.tick();
  assert.equal(f.gateway.patches.length, 1);
  assert.deepEqual(f.applied, [home.id]);
  assert.equal(f.changes.pending, false);
});

test("a change while no Gateway is ready stays pending for the next start", async (t) => {
  const f = setup(t);
  const home = f.agent("Home");
  const docs = f.http();
  f.runtime.client.ready = false;
  const saved = await f.service.update(home.id, { mcpServers: [docs.id] }, 1);
  assert.equal(saved.pending, true);
  assert.equal(f.changes.pending, true);
  assert.deepEqual(f.gateway.patches, []);
  // The start answered (afterReady) with its snapshot from before the change.
  f.runtime.client.ready = true;
  f.changes.ready();
  await f.tick();
  assert.equal(f.gateway.patches.length, 1);
  assert.equal(f.changes.pending, false);
});

test("an unreadable store omits bindings from the agent list instead of failing", async (t) => {
  const f = setup(t);
  f.agent("Home");
  f.servers.bindings = () => {
    throw Error("SQLITE_IOERR");
  };
  const [listed] = f.service.list().assistants;
  assert.equal(listed.name, "Home");
  assert.equal(listed.mcpServers, undefined);
});

test("a failed apply of a changed server or a removal still succeeds as pending", async (t) => {
  const f = setup(t);
  const home = f.agent("Home");
  const docs = f.http();
  await f.service.update(home.id, { mcpServers: [docs.id] }, 1);
  assert.equal(f.changes.pending, false);
  f.failPatches(2);
  const updated = await f.changes.update(docs.id, {
    revision: 1,
    url: "https://mcp.example.com/v2",
  });
  assert.equal(updated.pending, true);
  assert.equal(updated.server.url, "https://mcp.example.com/v2");
  assert.equal(f.servers.get(docs.id).url, "https://mcp.example.com/v2");
  const removed = await f.changes.remove(docs.id);
  assert.equal(removed.pending, true);
  assert.deepEqual(f.servers.bindings("agent", home.id), []);
  f.clock(5000);
  await f.tick();
  assert.equal(f.changes.pending, false);
  assert.deepEqual(f.gateway.config.mcp?.servers || {}, {});
});

test("a failed MCP apply still applies capabilities and bumps the revision", async (t) => {
  const f = setup(t);
  const home = f.agent("Home");
  const docs = f.http();
  f.failPatches(1);
  const changed = [];
  f.service.changed = () => changed.push(true);
  const saved = await f.service.update(
    home.id,
    { mcpServers: [docs.id], capabilities: { memory: true, reminders: false } },
    1,
  );
  assert.equal(saved.pending, true);
  assert.equal(saved.revision, 2);
  assert.equal(saved.capabilities.memory, true);
  assert.deepEqual(f.applied, [home.id]);
  assert.equal(changed.length, 1);
});
