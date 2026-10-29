import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SyncQueue } from "../../server/lib/sync-queue.js";
import { SessionSshAgents } from "../../server/features/ssh/ssh-session-agents.js";
import { owner, personal, setup, trusted } from "../helpers/agent-ssh-shell-fixture.js";
import { hostA, hostB } from "../helpers/ssh-session-agents-fixture.js";

const busy = (queue) => queue.run(() => new Promise((r) => setTimeout(r, 20)));

test("passes of different keys never share a run; a call during a pass runs again", async () => {
  const queue = new SyncQueue();
  const ran = [];
  busy(queue);
  const first = queue.coalesce(async () => ran.push("session"), "session");
  const second = queue.coalesce(async () => ran.push("agent"), "agent");
  const shared = queue.coalesce(async () => ran.push("agent again"), "agent");
  assert.notEqual(first, second);
  assert.equal(second, shared);
  await Promise.all([first, second]);
  assert.deepEqual(ran, ["session", "agent"]);
  // A call while the pass runs gets its own pass after it.
  let release;
  const running = queue.coalesce(
    () => queue.run(() => new Promise((r) => (release = r))),
    "agent",
  );
  await new Promise((r) => setTimeout(r, 5));
  const trailing = queue.coalesce(async () => ran.push("trailing"), "agent");
  assert.notEqual(trailing, running);
  release();
  await Promise.all([running, trailing]);
  assert.deepEqual(ran.at(-1), "trailing");
});

// The sessions' adapter on the agents' registry, counting its refresh passes.
function sessionsOn(s) {
  const counted = { lists: 0 };
  const sessions = new SessionSshAgents({
    dataDir: s.dataDir,
    store: { list: () => [hostA, hostB] },
    grants: { effective: async () => [] },
    sessions: {
      list: async () => {
        counted.lists += 1;
        return [];
      },
    },
    registry: s.registry,
  });
  return { sessions, counted };
}

for (const order of ["session first", "agent first"]) {
  test(`a session and an agent refresh both run their pass (${order})`, async (t) => {
    const s = setup(t);
    const a = s.add(personal(), [trusted(hostA)]);
    await s.shell.refresh();
    assert.ok(s.registry.get(owner(a)));
    const { sessions, counted } = sessionsOn(s);
    busy(s.registry.syncs);
    s.add({ ...a, archivedAt: "2026-10-29T00:00:00Z" });
    const passes =
      order === "session first"
        ? [sessions.refresh(), s.shell.refresh()]
        : [s.shell.refresh(), sessions.refresh()];
    await Promise.all(passes);
    assert.equal(counted.lists, 1);
    assert.equal(s.registry.get(owner(a)), undefined);
    assert.equal(fs.existsSync(s.folder(a)), false);
  });
}

test("an agent refresh called while a pass runs gets a pass of its own", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA)]);
  let second = null;
  const { list } = s.shell.agents;
  s.shell.agents = {
    ...s.shell.agents,
    list: () => {
      const profiles = list();
      if (!second) {
        // The agent is archived while the first pass reads the profiles.
        s.add({ ...a, archivedAt: "2026-10-29T00:00:00Z" });
        second = s.shell.refresh();
      }
      return profiles;
    },
  };
  await s.shell.refresh();
  assert.ok(second);
  await second;
  assert.equal(s.registry.get(owner(a)), undefined);
  assert.equal(fs.existsSync(s.folder(a)), false);
});

test("a wanted agent that cannot run now keeps its folder and token", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA)]);
  await s.shell.refresh();
  const socketPath = s.socketPath(a);
  const state = fs.readFileSync(s.state(a), "utf8");
  const breaks = [
    [
      "no-openssh",
      () => (s.shell.pathEnv = path.join(s.dataDir, "no-bin")),
      () => (s.shell.pathEnv = undefined),
    ],
    [
      "openssh-too-old",
      () => (s.registry.openssh = { major: 8, minor: 8 }),
      () => (s.registry.openssh = { major: 10, minor: 2 }),
    ],
    ["failed", () => (s.accessFails = true), () => (s.accessFails = false)],
  ];
  for (const [reason, breakIt, mend] of breaks) {
    breakIt();
    await s.shell.refresh();
    assert.equal(s.registry.get(owner(a)), undefined, reason);
    assert.equal(fs.readFileSync(s.state(a), "utf8"), state);
    assert.equal(fs.existsSync(path.dirname(socketPath)), true);
    if (reason !== "failed")
      assert.deepEqual(s.shell.status(a.id), { state: "unavailable", reason });
    if (reason === "failed") assert.equal(await s.shell.authorize(a.id), null);
    mend();
    await s.shell.refresh();
    assert.equal(s.socketPath(a), socketPath, reason);
    assert.equal(s.shell.status(a.id).state, "ready");
  }
  // No longer wanted: socket, folder and token go.
  s.grants.set(a.id, []);
  await s.shell.refresh();
  assert.equal(fs.existsSync(s.folder(a)), false);
  assert.equal(fs.existsSync(path.dirname(socketPath)), false);
});

test("a teardown that throws never stops the pass or its notification", async (t) => {
  const s = setup(t);
  const a = s.add(personal(), [trusted(hostA)]);
  const b = s.add(personal(), [trusted(hostA)]);
  await s.shell.refresh();
  const teardown = s.registry.teardown.bind(s.registry);
  s.registry.teardown = async (o, token) => {
    if (o.id === a.id) {
      await teardown(o, token);
      throw Object.assign(new Error("boom"), { code: "EBUSY" });
    }
    return teardown(o, token);
  };
  s.heard.length = 0;
  s.agents.delete(a.id);
  s.agents.delete(b.id);
  await s.shell.refresh();
  assert.equal(s.registry.get(owner(b)), undefined);
  assert.equal(fs.existsSync(s.folder(b)), false);
  assert.deepEqual(s.heard.sort(), [a.id, b.id].sort());
  assert.ok(s.logs.some(([, message]) => /could not be removed/.test(message)));
});
