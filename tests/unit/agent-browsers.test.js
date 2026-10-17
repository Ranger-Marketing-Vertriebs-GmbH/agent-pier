import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentBrowsers } from "../../server/features/assistants/agent-browsers.js";
import { browserProfileMap } from "../../server/features/assistants/openclaw-config/browser-profiles.js";
import {
  browserCall,
  browserRefusals,
} from "../../server/features/assistants/team-plugin/tool-guard.js";

const visibleApp = {
  available: true,
  executablePath: "/b",
  visible: { available: true },
};
const agent = (id, extra = {}) => ({
  id,
  runtimeAgentId: `ap-${id}`,
  capabilities: { browser: true },
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

function fixture(t, profiles, { limit = 3, busy = () => false } = {}) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browsers-"));
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
  const runtime = {
    paths: { state },
    client: {
      ready: true,
      request: async (method, params) => requests.push([method, params]),
    },
    webTools: {
      browserProfiles: browserProfileMap({ profiles, browser: visibleApp, port: 40000 }),
      visibleBrowser: true,
    },
  };
  const keepers = [];
  const browsers = new AgentBrowsers({
    store,
    runtime,
    limit,
    busy,
    now: () => clock,
    keeper: (cdpPort, options) => {
      const keeper = { cdpPort, closed: false, open: false, ...options };
      keeper.start = async () => true;
      keeper.close = () => (keeper.closed = true);
      keeper.inUse = async () => keeper.open;
      keepers.push(keeper);
      return keeper;
    },
  });
  return {
    browsers,
    records,
    requests,
    keepers,
    state,
    runtime,
    tick: (ms) => (clock += ms),
    stops: () =>
      requests.filter(([, p]) => p.path === "/stop").map(([, p]) => p.query.profile),
  };
}

test("each agent's calls are pinned to its own profile; imports are refused", async (t) => {
  const f = fixture(t, [agent("a"), agent("b"), agent("c", { capabilities: {} })]);
  assert.deepEqual(await f.browsers.policy({ agentId: "ap-a", action: "open" }), {
    allow: true,
    profile: "agent-a",
  });
  assert.equal((await f.browsers.policy({ agentId: "ap-b" })).profile, "agent-b");
  assert.deepEqual(
    await f.browsers.policy({ agentId: "ap-a", action: "importprofile" }),
    {
      allow: false,
      reason: "importBlocked",
    },
  );
  assert.equal((await f.browsers.policy({ agentId: "ap-c" })).reason, "notGranted");
  assert.equal((await f.browsers.policy({ agentId: "ap-x" })).reason, "notGranted");
  f.runtime.client.ready = false;
  assert.equal((await f.browsers.policy({ agentId: "ap-a" })).reason, "unavailable");
  await assert.rejects(() => f.browsers.policy({ agentId: "ap-a", profile: "x" }));
});

test("an agent switched on after the Gateway start waits for a restart", async (t) => {
  const f = fixture(t, [agent("a")]);
  f.records.set("late", agent("late"));
  assert.equal((await f.browsers.policy({ agentId: "ap-late" })).reason, "restartNeeded");
});

test("at most three visible browsers: the least recently used idle one stops", async (t) => {
  const ids = ["a", "b", "c", "d"];
  const f = fixture(
    t,
    ids.map((id) => agent(id, { browserVisible: true })),
  );
  for (const id of ids.slice(0, 3)) {
    assert.equal((await f.browsers.policy({ agentId: `ap-${id}` })).allow, true);
    f.tick(1000);
  }
  // Every browser was used within the last five minutes: the fourth is refused.
  assert.deepEqual(await f.browsers.policy({ agentId: "ap-d" }), {
    allow: false,
    reason: "visibleLimit",
  });
  f.tick(5 * 60_000);
  await f.browsers.policy({ agentId: "ap-b" });
  assert.equal((await f.browsers.policy({ agentId: "ap-d" })).allow, true);
  assert.deepEqual(f.stops(), ["agent-a"]);
  assert.equal(f.browsers.isRunning("a"), false);
  assert.equal(f.browsers.isRunning("d"), true);
  // Visible browsers are watched (minimized, kept rendering); the stopped one released.
  assert.equal(f.keepers.length, 4);
  assert.equal(f.keepers[0].closed, true);
});

test("headless browsers do not count against the visible limit", async (t) => {
  const f = fixture(t, [agent("v", { browserVisible: true }), agent("h")], { limit: 1 });
  await f.browsers.policy({ agentId: "ap-v" });
  assert.equal((await f.browsers.policy({ agentId: "ap-h" })).allow, true);
  // Both are watched; only the visible one has its windows managed.
  assert.deepEqual(
    f.keepers.map((k) => k.windows),
    [true, false],
  );
});

test("an idle browser stops after fifteen minutes", async (t) => {
  const f = fixture(t, [agent("a"), agent("b")]);
  await f.browsers.policy({ agentId: "ap-a" });
  await f.browsers.policy({ agentId: "ap-b" });
  f.tick(14 * 60_000);
  await f.browsers.policy({ agentId: "ap-b" });
  f.tick(60_000);
  await f.browsers.sweep();
  assert.deepEqual(f.stops(), ["agent-a"]);
  assert.equal(f.browsers.status("a").running, false);
  assert.equal(f.browsers.status("b").running, true);
});

test("members borrow a slot, follow their lead's window and lose it when they end", async (t) => {
  const lead = agent("lead", { browserVisible: true });
  const f = fixture(t, [lead, member("m1", "lead"), member("m2", "lead")]);
  assert.equal(
    (await f.browsers.policy({ agentId: "ap-m1" })).profile,
    "member-visible-1",
  );
  assert.equal(
    (await f.browsers.policy({ agentId: "ap-m2" })).profile,
    "member-visible-2",
  );
  assert.equal(
    (await f.browsers.policy({ agentId: "ap-m1" })).profile,
    "member-visible-1",
  );
  const slot = path.join(f.state, "browser", "member-visible-1", "user-data");
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, "Cookies"), "member login");
  // m1 ends: its slot data is discarded; m2 is promoted and keeps its logins.
  f.records.delete("m1");
  const promoted = {
    ...member("m2", "lead"),
    lifetime: "permanent",
    inherited: undefined,
  };
  f.records.set("m2", promoted);
  const kept = path.join(f.state, "browser", "member-visible-2", "user-data");
  fs.mkdirSync(kept, { recursive: true });
  fs.writeFileSync(path.join(kept, "Cookies"), "promoted login");
  await f.browsers.sweep();
  assert.equal(fs.existsSync(path.join(f.state, "browser", "member-visible-1")), false);
  assert.equal(
    fs.readFileSync(
      path.join(f.state, "browser", "agent-m2", "user-data", "Cookies"),
      "utf8",
    ),
    "promoted login",
  );
  assert.deepEqual(f.stops().sort(), ["member-visible-1", "member-visible-2"]);
  // A member of a lead without a window gets a headless slot.
  f.records.set("lead", agent("lead"));
  f.records.set("m3", member("m3", "lead"));
  assert.equal((await f.browsers.policy({ agentId: "ap-m3" })).profile, "member-1");
});

test("all slots taken refuses another member until one ends", async (t) => {
  const members = ["m1", "m2", "m3", "m4"].map((id) => member(id, "lead"));
  const f = fixture(t, [agent("lead"), ...members]);
  for (const m of members.slice(0, 3))
    assert.equal((await f.browsers.policy({ agentId: m.runtimeAgentId })).allow, true);
  assert.equal((await f.browsers.policy({ agentId: "ap-m4" })).reason, "slotsBusy");
});

test("slot data nobody holds is removed, for example after AgentPier restarted", async (t) => {
  const f = fixture(t, [agent("a")]);
  const stale = path.join(f.state, "browser", "member-2", "user-data");
  fs.mkdirSync(stale, { recursive: true });
  fs.mkdirSync(path.join(f.state, "browser", "agent-a", "user-data"), {
    recursive: true,
  });
  await f.browsers.sweep();
  assert.equal(fs.existsSync(path.join(f.state, "browser", "member-2")), false);
  assert.equal(fs.existsSync(path.join(f.state, "browser", "agent-a")), true);
});

test("resetting the profile stops the browser and deletes its data", async (t) => {
  const f = fixture(t, [agent("a"), member("m1", "a")]);
  await f.browsers.policy({ agentId: "ap-a" });
  const dir = path.join(f.state, "browser", "agent-a", "user-data");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Cookies"), "login");
  assert.equal(f.browsers.status("a").stored, true);
  assert.deepEqual(await f.browsers.reset("a"), {
    running: false,
    visible: false,
    stored: false,
    resettable: true,
  });
  assert.deepEqual(f.stops(), ["agent-a"]);
  await assert.rejects(() => f.browsers.reset("m1"));
});

test("a Gateway that leaves ready forgets every browser", async (t) => {
  const f = fixture(t, [agent("a", { browserVisible: true })]);
  let listener;
  f.runtime.on = (_name, fn) => (listener = fn);
  const browsers = new AgentBrowsers({
    store: { listAssistants: () => [...f.records.values()], getAssistant: () => null },
    runtime: f.runtime,
    keeper: () => ({ start: async () => true, close() {} }),
  });
  await browsers.policy({ agentId: "ap-a" });
  assert.equal(browsers.isRunning("a"), true);
  // A reconnect keeps the Gateway's browsers; a failure or a new start does not.
  listener({ availability: "reconnecting" });
  listener({ availability: "ready" });
  assert.equal(browsers.isRunning("a"), true);
  listener({ availability: "failed" });
  assert.equal(browsers.isRunning("a"), false);
  await browsers.policy({ agentId: "ap-a" });
  f.runtime.generation = 7;
  listener({ availability: "ready" });
  assert.equal(browsers.isRunning("a"), false);
});

test("the tool guard pins the profile and fails closed", async () => {
  const answer =
    (body, ok = true) =>
    async () => ({ ok, json: async () => body });
  const event = { params: { action: "open", url: "https://x", profile: "agent-b" } };
  const ctx = { agentId: "ap-a" };
  assert.deepEqual(
    await browserCall(event, ctx, answer({ allow: true, profile: "agent-a" })),
    { params: { action: "open", url: "https://x", profile: "agent-a", target: "host" } },
  );
  assert.deepEqual(
    await browserCall(event, ctx, answer({ allow: false, reason: "visibleLimit" })),
    { block: true, blockReason: browserRefusals.visibleLimit },
  );
  for (const bridge of [
    answer({ allow: true }),
    answer({}, false),
    async () => {
      throw Error("down");
    },
  ])
    assert.deepEqual(await browserCall(event, ctx, bridge), {
      block: true,
      blockReason: browserRefusals.unavailable,
    });
  let sent;
  await browserCall({ params: {} }, ctx, async (_url, body) => {
    sent = body;
    return { ok: false };
  });
  assert.deepEqual(sent, { agentId: "ap-a" });
});

test("calls that never launch a browser do not count as running", async (t) => {
  const f = fixture(t, [agent("a", { browserVisible: true })], { limit: 0 });
  for (const action of ["status", "profiles", " Status ", "doctor"])
    assert.equal((await f.browsers.policy({ agentId: "ap-a", action })).allow, true);
  assert.equal(f.browsers.isRunning("a"), false);
  assert.equal(f.keepers.length, 0);
  // Any spelling of a refused action stays refused.
  assert.equal(
    (await f.browsers.policy({ agentId: "ap-a", action: " ImportProfile " })).reason,
    "importBlocked",
  );
  assert.equal(
    (await f.browsers.policy({ agentId: "ap-a", action: "open" })).reason,
    "visibleLimit",
  );
});

test("a browser that ended is released and the next launch watches it again", async (t) => {
  const f = fixture(t, [agent("a", { browserVisible: true })]);
  await f.browsers.policy({ agentId: "ap-a", action: "open" });
  assert.equal(f.browsers.isRunning("a"), true);
  f.keepers[0].onClose();
  assert.equal(f.browsers.isRunning("a"), false);
  await f.browsers.policy({ agentId: "ap-a", action: "navigate" });
  assert.equal(f.keepers.length, 2);
  assert.equal(f.browsers.isRunning("a"), true);
  // A stale close of the old watcher does not touch the new browser.
  f.keepers[0].onClose();
  assert.equal(f.browsers.isRunning("a"), true);
});

test("a working agent or an open window is never stopped for another", async (t) => {
  const ids = ["a", "b", "c"];
  const working = new Set(["a"]);
  const f = fixture(
    t,
    [...ids, "d"].map((id) => agent(id, { browserVisible: true })),
    { limit: 3, busy: (id) => working.has(id) },
  );
  for (const id of ids) await f.browsers.policy({ agentId: `ap-${id}`, action: "open" });
  f.tick(10 * 60_000);
  f.keepers[1].open = true;
  // a works, b's window is open: c, the next least recently used, makes room.
  assert.equal(
    (await f.browsers.policy({ agentId: "ap-d", action: "open" })).allow,
    true,
  );
  assert.deepEqual(f.stops(), ["agent-c"]);
});

test("concurrent launches never pass the visible limit", async (t) => {
  const ids = ["a", "b", "c", "d", "e"];
  const f = fixture(
    t,
    ids.map((id) => agent(id, { browserVisible: true })),
  );
  for (const id of ids.slice(0, 3))
    await f.browsers.policy({ agentId: `ap-${id}`, action: "open" });
  f.tick(10 * 60_000);
  const answers = await Promise.all([
    f.browsers.policy({ agentId: "ap-d", action: "open" }),
    f.browsers.policy({ agentId: "ap-e", action: "open" }),
  ]);
  assert.deepEqual(
    answers.map((a) => a.allow),
    [true, true],
  );
  assert.equal([...f.browsers.running.values()].filter((e) => !e.headless).length, 3);
});

test("an archived agent keeps its profile and can reset it", async (t) => {
  const f = fixture(t, [agent("a")]);
  f.records.set("a", agent("a", { archivedAt: "2026-10-17T00:00:00Z" }));
  const dir = path.join(f.state, "browser", "agent-a", "user-data");
  fs.mkdirSync(dir, { recursive: true });
  assert.deepEqual(f.browsers.status("a"), {
    running: false,
    visible: false,
    stored: true,
    resettable: true,
  });
  await f.browsers.reset("a");
  assert.equal(fs.existsSync(path.join(f.state, "browser", "agent-a")), false);
});

test("a slot being discarded is never handed to another member", async (t) => {
  const f = fixture(t, [agent("lead"), member("m1", "lead"), member("m2", "lead")]);
  assert.equal((await f.browsers.policy({ agentId: "ap-m1" })).profile, "member-1");
  f.records.delete("m1");
  let release;
  f.runtime.client.request = () => new Promise((r) => (release = r));
  const sweeping = f.browsers.sweep();
  await new Promise((r) => setImmediate(r));
  // m1's slot is still being discarded: m2 gets another one.
  assert.equal((await f.browsers.policy({ agentId: "ap-m2" })).profile, "member-2");
  release();
  await sweeping;
});

test("an idle browser whose window the owner has open keeps running, up to a cap", async (t) => {
  const f = fixture(t, [agent("a", { browserVisible: true })]);
  await f.browsers.policy({ agentId: "ap-a", action: "open" });
  f.keepers[0].open = true;
  f.tick(20 * 60_000);
  await f.browsers.sweep();
  assert.equal(f.browsers.isRunning("a"), true);
  f.tick(60 * 60_000);
  await f.browsers.sweep();
  assert.equal(f.browsers.isRunning("a"), false);
  assert.deepEqual(f.stops(), ["agent-a"]);
});

test("two first calls for the same profile at the limit evict nothing extra", async (t) => {
  const ids = ["a", "b", "c", "d"];
  const f = fixture(
    t,
    ids.map((id) => agent(id, { browserVisible: true })),
  );
  for (const id of ids.slice(0, 3))
    await f.browsers.policy({ agentId: `ap-${id}`, action: "open" });
  f.tick(10 * 60_000);
  await Promise.all([
    f.browsers.policy({ agentId: "ap-d", action: "open" }),
    f.browsers.policy({ agentId: "ap-d", action: "navigate" }),
  ]);
  assert.equal(f.stops().length, 1);
  assert.equal([...f.browsers.running.values()].filter((e) => !e.headless).length, 3);
});
