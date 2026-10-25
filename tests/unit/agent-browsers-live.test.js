import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AgentBrowsers } from "../../server/features/assistants/agent-browsers.js";
import { BrowserLiveView } from "../../server/features/assistants/browser-live-view.js";
import { browserProfileMap } from "../../server/features/assistants/openclaw-config/browser-profiles.js";

const visibleApp = {
  available: true,
  executablePath: "/b",
  visible: { available: true },
};
const agent = (id, extra = {}) => ({
  id,
  runtimeAgentId: `ap-${id}`,
  capabilities: { browser: true },
  browserVisible: true,
  ...extra,
});
const member = (id, lead) => ({
  id,
  runtimeAgentId: `ap-${id}`,
  teamMemberId: id,
  lifetime: "task",
  parentAssistantId: lead,
  inherited: { capabilities: { browser: true }, skills: [], shell: "off", ssh: false },
});
const settle = async () => {
  for (let n = 0; n < 5; n++) await new Promise((r) => setTimeout(r, 2));
};

// Real AgentBrowsers and BrowserLiveView over a fake Gateway that runs every browser.
function fixture(t, profiles) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browsers-live-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  let clock = 1_000_000;
  const records = new Map(profiles.map((p) => [p.id, p]));
  const store = {
    listAssistants: () => [...records.values()],
    getAssistant: (id) => {
      if (!records.has(id)) throw Error("missing");
      return records.get(id);
    },
  };
  const requests = [];
  const client = {
    ready: true,
    request: async (_method, params) => {
      requests.push(params);
      if (params.path === "/") return { running: true };
      if (params.path === "/tabs")
        return { tabs: [{ targetId: "t1", url: "https://a/" }] };
      if (params.path === "/screencast")
        return { wsPath: "/browser/screencast?token=x", targetId: "t1" };
      return {};
    },
    openStream: () => {
      const ws = new EventEmitter();
      ws.close = () => ws.emit("close", 1000);
      return ws;
    },
  };
  const runtime = {
    paths: { state },
    client,
    webTools: {
      browserProfiles: browserProfileMap({ profiles, browser: visibleApp, port: 40000 }),
      visibleBrowser: true,
    },
  };
  const keeper = () => ({
    start: async () => true,
    close() {},
    inUse: async () => false,
  });
  const browsers = new AgentBrowsers({ store, runtime, now: () => clock, keeper });
  const live = new BrowserLiveView({
    browsers,
    runtime,
    pollMs: 60_000,
    now: () => clock,
  });
  const viewer = { state() {}, frame() {}, end() {} };
  return {
    browsers,
    live,
    viewer,
    requests,
    tick: (ms) => (clock += ms),
    stops: () => requests.filter((p) => p.path === "/stop").map((p) => p.query.profile),
  };
}

test("ownerStart respects the visible limit and starts the agent's own profile", async (t) => {
  const f = fixture(
    t,
    ["a", "b", "c", "d"].map((id) => agent(id)),
  );
  for (const id of ["a", "b", "c"])
    await f.browsers.policy({ agentId: `ap-${id}`, action: "open" });
  await assert.rejects(f.browsers.ownerStart("d"), { key: "browserVisibleLimit" });
  assert.equal(
    f.requests.some((p) => p.path === "/start"),
    false,
  );
  f.tick(10 * 60_000);
  assert.deepEqual(await f.browsers.ownerStart("d"), { profile: "agent-d" });
  assert.deepEqual(f.requests.at(-1), {
    method: "POST",
    path: "/start",
    query: { profile: "agent-d" },
  });
  // policy() still admits through the same path.
  assert.equal(
    (await f.browsers.policy({ agentId: "ap-a", action: "open" })).allow,
    true,
  );
});

test("ownerStop stops the profile the live view shows and forgets it", async (t) => {
  const f = fixture(t, [agent("a"), agent("lead"), member("m1", "lead")]);
  await f.browsers.ownerStart("a");
  assert.equal(f.browsers.running.has("agent-a"), true);
  await f.browsers.ownerStop("a");
  assert.deepEqual(f.stops(), ["agent-a"]);
  assert.equal(f.browsers.running.has("agent-a"), false);
  // A stop the Gateway refuses reaches the owner, and the browser stays tracked.
  await f.browsers.ownerStart("a");
  const request = f.browsers.runtime.client.request;
  f.browsers.runtime.client.request = async () => {
    throw Error("timeout");
  };
  await assert.rejects(f.browsers.ownerStop("a"), /timeout/);
  assert.equal(f.browsers.running.has("agent-a"), true);
  f.browsers.runtime.client.request = request;
  // A member without a slot has nothing to stop.
  await assert.rejects(f.browsers.ownerStop("m1"), { key: "invalid" });
  f.browsers.runtime.client.ready = false;
  await assert.rejects(f.browsers.ownerStop("a"), { key: "unavailable" });
});

test("viewProfile never assigns a member slot", (t) => {
  const f = fixture(t, [agent("lead"), member("m1", "lead")]);
  assert.equal(f.browsers.viewProfile("m1"), null);
  assert.equal(f.browsers.viewReason("m1"), "noSlot");
  assert.equal(f.browsers.slots.size, 0);
  assert.equal(f.browsers.viewProfile("lead").name, "agent-lead");
  assert.equal(f.browsers.viewReason("lead"), "noProfile");
});

test("watching re-tracks a running browser only within the visible limit", (t) => {
  const f = fixture(
    t,
    ["a", "b", "c", "d"].map((id) => agent(id)),
  );
  // After an AgentPier restart nothing is tracked although browsers run.
  for (const id of ["a", "b", "c"]) f.browsers.watched(id, { full: true });
  assert.equal(f.browsers.running.size, 3);
  f.browsers.watched("d", { full: true });
  assert.equal(f.browsers.running.has("agent-d"), false);
});

test("an open chat preview never keeps a browser alive", async (t) => {
  const f = fixture(t, [agent("a")]);
  await f.browsers.policy({ agentId: "ap-a", action: "open" });
  const preview = f.live.subscribe("a", f.viewer, { preview: true });
  await settle();
  f.tick(16 * 60_000);
  f.live.streams.get("a").wake();
  await settle();
  await f.browsers.sweep();
  assert.deepEqual(f.stops(), ["agent-a"]);
  preview.close();
});

test("a watching owner keeps a browser, but not beyond the idle cap", async (t) => {
  const f = fixture(t, [agent("a")]);
  await f.browsers.policy({ agentId: "ap-a", action: "open" });
  const view = f.live.subscribe("a", f.viewer);
  await settle();
  for (let n = 0; n < 4; n++) {
    f.tick(14 * 60_000);
    f.live.streams.get("a").wake();
    await settle();
    await f.browsers.sweep();
  }
  // 56 minutes of watching kept it; after the hour it stops all the same.
  assert.deepEqual(f.stops(), []);
  f.tick(14 * 60_000);
  f.live.streams.get("a").wake();
  await settle();
  f.tick(14 * 60_000);
  await f.browsers.sweep();
  assert.deepEqual(f.stops(), ["agent-a"]);
  view.close();
});

test("three open chat previews do not block another agent's browser", async (t) => {
  const f = fixture(
    t,
    ["a", "b", "c", "d"].map((id) => agent(id)),
  );
  const previews = [];
  for (const id of ["a", "b", "c"]) {
    await f.browsers.policy({ agentId: `ap-${id}`, action: "open" });
    previews.push(f.live.subscribe(id, f.viewer, { preview: true }));
  }
  await settle();
  f.tick(10 * 60_000);
  for (const id of ["a", "b", "c"]) f.live.streams.get(id).wake();
  await settle();
  assert.equal(
    (await f.browsers.policy({ agentId: "ap-d", action: "open" })).allow,
    true,
  );
  assert.equal(f.stops().length, 1);
  for (const p of previews) p.close();
});
