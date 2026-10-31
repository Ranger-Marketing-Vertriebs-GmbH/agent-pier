import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspaceState,
  withoutReadStamp,
} from "../../server/features/sessions/workspace-state.js";

// The services GET /api/state reads, with counted detectors.
function fixture({ slowMs = 60000 } = {}) {
  const calls = { utilities: 0, tools: 0, sessions: 0 };
  let clock = 1000;
  let sessions = [{ id: "one", name: "Eins", cwd: "/nowhere" }];
  const services = {
    config: { home: "/home/owner", dataDir: "", remoteUrl: "" },
    tools: () => {
      calls.tools += 1;
      return [{ id: "shell", name: "Shell", installed: true, path: "/bin/sh" }];
    },
    accounts: { list: () => [{ id: "local-shell", tool: "shell" }] },
    providerConnections: { list: () => [] },
    sessions: {
      list: async () => {
        calls.sessions += 1;
        return sessions;
      },
    },
    activity: {
      enrich: async (list) => list.map((item) => ({ ...item, activity: null })),
    },
    inbox: { summary: async () => ({ counts: { all: 0 } }) },
    notifications: {
      deviceCount: () => 2,
      ownerHealth: () => ({ devices: 2, lost: false, failing: true }),
    },
    preferences: { get: () => ({ defaultCwd: "/home/owner" }) },
  };
  const state = createWorkspaceState(services, {
    slowMs,
    now: () => clock,
    detectUtilities: () => {
      calls.utilities += 1;
      return [{ id: "git", utility: true, installed: true }];
    },
  });
  return {
    state,
    services,
    calls,
    advance: (ms) => (clock += ms),
    setSessions: (next) => (sessions = next),
  };
}

test("the state has the shape of GET /api/state", async () => {
  const { state } = fixture();
  const value = await state.read();
  assert.deepEqual(value, {
    tools: [{ id: "shell", name: "Shell", installed: true, path: "/bin/sh" }],
    utilities: [{ id: "git", utility: true, installed: true }],
    accounts: [{ id: "local-shell", tool: "shell" }],
    sharedCliExtensions: true,
    providerConnections: [],
    sessions: [
      { id: "one", name: "Eins", cwd: "/nowhere", activity: null, repositoryName: null },
    ],
    inbox: { counts: { all: 0 } },
    pushDevices: 2,
    pushHealth: { devices: 2, lost: false, failing: true },
    home: "/home/owner",
    defaultCwd: "/home/owner",
    remoteUrl: null,
    readStartedAt: 1000,
  });
});

test("each read is stamped higher than the one started before it", async () => {
  const { state, advance } = fixture();
  const first = state.read();
  const second = state.read();
  const stamps = [(await first).readStartedAt, (await second).readStartedAt];
  assert.deepEqual(stamps, [1000, 1001]);
  advance(5000);
  assert.equal((await state.read()).readStartedAt, 6000);
  const { readStartedAt, ...rest } = await state.read();
  assert.ok(readStartedAt > 6000);
  assert.deepEqual(withoutReadStamp({ ...rest, readStartedAt }), rest);
});

test("two reads within slowMs detect tools and utilities once", async () => {
  const { state, calls, advance, setSessions } = fixture();
  await state.read();
  advance(59000);
  setSessions([]);
  const second = await state.read();
  assert.deepEqual(second.sessions, []);
  assert.equal(calls.sessions, 2);
  assert.deepEqual(
    { utilities: calls.utilities, tools: calls.tools },
    { utilities: 1, tools: 1 },
  );
});

test("invalidateSlow() and an expired cache detect again", async () => {
  const { state, calls, advance } = fixture();
  await state.read();
  state.invalidateSlow();
  await state.read();
  assert.equal(calls.utilities, 2);
  advance(60000);
  await state.read();
  assert.equal(calls.utilities, 3);
  await state.read({ fresh: true });
  assert.equal(calls.utilities, 4);
  assert.equal(calls.tools, 4);
});

test("concurrent reads share one detection", async () => {
  const { state, calls } = fixture();
  await Promise.all([state.read(), state.read(), state.read()]);
  assert.equal(calls.utilities, 1);
});

test("a failed inbox summary leaves the state without it", async () => {
  const { state, services } = fixture();
  services.inbox = {
    summary: async () => {
      throw new Error("down");
    },
  };
  assert.equal((await state.read()).inbox, null);
});

test("a read reuses a session list the collect just offered, once", async () => {
  const { state, calls, advance } = fixture();
  state.offerSessions([{ id: "two", name: "Zwei", cwd: "/nowhere" }]);
  const offered = await state.read();
  assert.equal(calls.sessions, 0);
  assert.deepEqual(
    offered.sessions.map((session) => session.id),
    ["two"],
  );
  // Used once: the next read lists again.
  assert.deepEqual(
    (await state.read()).sessions.map((session) => session.id),
    ["one"],
  );
  assert.equal(calls.sessions, 1);
  // An offer older than the window is not used.
  state.offerSessions([{ id: "old", name: "Alt", cwd: "/nowhere" }]);
  advance(1001);
  assert.deepEqual(
    (await state.read()).sessions.map((session) => session.id),
    ["one"],
  );
  assert.equal(calls.sessions, 2);
});

test("a read that reuses an offered list is dated to that listing", async () => {
  const { state, advance } = fixture();
  advance(5000);
  state.offerSessions([{ id: "two", name: "Zwei", cwd: "/nowhere" }], 3000);
  const based = [];
  const value = await state.read({ basedOn: (stamp) => based.push(stamp) });
  assert.equal(value.readStartedAt, 3000);
  assert.deepEqual(based, [3000]);
  // A read that lists the sessions itself is dated to its own start.
  assert.ok((await state.read()).readStartedAt > 3000);
});
