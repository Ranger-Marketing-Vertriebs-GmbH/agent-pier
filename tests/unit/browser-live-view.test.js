import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserLiveView } from "../../server/features/assistants/browser-live-view.js";

const tick = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let n = 0; n < 5; n++) {
    await tick();
    await new Promise((r) => setTimeout(r, 2));
  }
}

// A Gateway stand-in: browser.request answers and screencast sockets.
function fixture({
  running = true,
  tabs = [{ targetId: "t1", title: "One", url: "https://a.example/" }],
} = {}) {
  const gateway = { running, tabs, tickets: [], sockets: [], starts: [] };
  const client = {
    ready: true,
    request: async (method, { method: verb, path, query, body }) => {
      assert.equal(method, "browser.request");
      assert.equal(query.profile, "agent-a");
      if (path === "/") return { running: gateway.running };
      if (path === "/tabs") return { running: true, tabs: gateway.tabs };
      if (verb === "POST" && path === "/screencast") {
        const targetId = body.targetId || gateway.tabs.at(-1)?.targetId;
        gateway.tickets.push(body);
        return {
          token: `token-${gateway.tickets.length}`,
          wsPath: `/browser/screencast?token=token-${gateway.tickets.length}`,
          targetId,
          url: gateway.tabs.find((tab) => tab.targetId === targetId)?.url,
        };
      }
      throw Error(`unexpected ${verb} ${path}`);
    },
    openStream: (wsPath) => {
      const ws = new EventEmitter();
      ws.wsPath = wsPath;
      ws.closed = false;
      ws.close = () => {
        ws.closed = true;
      };
      gateway.sockets.push(ws);
      return ws;
    },
  };
  const watched = [];
  const browsers = {
    viewProfile: () => ({ name: "agent-a", entry: { headless: false } }),
    watched: (id) => watched.push(id),
    ownerStart: async (id) => {
      gateway.starts.push(id);
      gateway.running = true;
    },
  };
  let clock = 0;
  const live = new BrowserLiveView({
    browsers,
    runtime: { client },
    pollMs: 60_000,
    retryMs: 0,
    previewMs: 1000,
    now: () => clock,
  });
  const viewer = () => {
    const seen = { states: [], frames: [] };
    seen.viewer = {
      state: (state) => seen.states.push(state),
      frame: (bytes) => seen.frames.push(bytes),
    };
    seen.last = () => seen.states.at(-1);
    return seen;
  };
  return { gateway, live, viewer, watched, tick: (ms) => (clock += ms) };
}

test("viewers of one agent share one upstream screencast", async () => {
  const f = fixture();
  const a = f.viewer(),
    b = f.viewer(),
    preview = f.viewer();
  const first = f.live.subscribe("a", a.viewer);
  await settle();
  const second = f.live.subscribe("a", b.viewer);
  const third = f.live.subscribe("a", preview.viewer, { preview: true });
  await settle();
  assert.equal(f.gateway.tickets.length, 1);
  assert.equal(f.gateway.sockets.length, 1);
  assert.deepEqual(f.gateway.tickets[0], {
    maxWidth: 1280,
    maxHeight: 1280,
    quality: 60,
  });
  const [ws] = f.gateway.sockets;
  assert.equal(ws.wsPath, "/browser/screencast?token=token-1");
  ws.emit(
    "message",
    JSON.stringify({
      type: "ready",
      targetId: "t1",
      url: "https://a.example/",
      title: "One",
    }),
    false,
  );
  for (let n = 0; n < 3; n++) {
    ws.emit("message", Buffer.from([0, 0, 0, 2, 123, 125, 255]), true);
    f.tick(600);
  }
  assert.equal(a.frames.length, 3);
  assert.equal(b.frames.length, 3);
  // A preview gets at most one frame a second.
  assert.equal(preview.frames.length, 2);
  assert.equal(a.last().status, "live");
  assert.equal(a.last().title, "One");
  assert.deepEqual(a.last().tabs, [
    { targetId: "t1", title: "One", url: "https://a.example/" },
  ]);
  // Watching keeps the browser tracked for the window keeper.
  assert.ok(f.watched.includes("a"));
  first.close();
  second.close();
  assert.equal(ws.closed, false);
  third.close();
  // The last viewer leaving ends the upstream; nothing polls any more.
  assert.equal(ws.closed, true);
  assert.equal(f.live.streams.size, 0);
});

test("an ended stream gets a fresh ticket; a blocked page says so", async () => {
  const f = fixture();
  const a = f.viewer();
  const subscription = f.live.subscribe("a", a.viewer);
  await settle();
  // A dropped connection (or a ticket that expired before use) is minted anew.
  f.gateway.sockets[0].emit("close", 1006);
  await settle();
  assert.equal(f.gateway.tickets.length, 2);
  // The tab closed: at once, for the browser's selected tab.
  f.gateway.sockets[1].emit("close", 4004);
  await settle();
  assert.equal(f.gateway.tickets.length, 3);
  f.gateway.sockets[2].emit("close", 4003);
  assert.equal(a.last().status, "blocked");
  assert.equal(a.last().reason, "navigation");
  subscription.close();
});

test("the owner picks a tab; a new tab is followed until then", async () => {
  const f = fixture();
  const a = f.viewer();
  const subscription = f.live.subscribe("a", a.viewer);
  await settle();
  f.gateway.tabs = [
    ...f.gateway.tabs,
    { targetId: "t2", title: "Two", url: "https://b.example/" },
  ];
  f.live.streams.get("a").wake();
  await settle();
  // The agent opened a tab: the view follows the browser's selected tab.
  assert.equal(f.gateway.tickets.length, 2);
  assert.equal(a.last().targetId, "t2");
  subscription.select("t1");
  await settle();
  assert.equal(f.gateway.tickets.at(-1).targetId, "t1");
  assert.equal(a.last().pinned, true);
  f.gateway.tabs = [
    ...f.gateway.tabs,
    { targetId: "t3", title: "Three", url: "https://c.example/" },
  ];
  f.live.streams.get("a").wake();
  await settle();
  // Picked: a further tab does not move the view.
  assert.equal(f.gateway.tickets.length, 3);
  subscription.follow();
  await settle();
  assert.equal(a.last().pinned, false);
  subscription.close();
});

test("a stopped browser is reported and the owner can start it", async () => {
  const f = fixture({ running: false });
  const a = f.viewer();
  const subscription = f.live.subscribe("a", a.viewer);
  await settle();
  assert.equal(a.last().status, "stopped");
  assert.equal(f.gateway.tickets.length, 0);
  await subscription.start();
  await settle();
  assert.deepEqual(f.gateway.starts, ["a"]);
  assert.equal(f.gateway.tickets.length, 1);
  subscription.close();
});

test("without a ready agent service or profile the view is unavailable", async () => {
  const f = fixture();
  f.live.runtime.client.ready = false;
  const a = f.viewer();
  const subscription = f.live.subscribe("a", a.viewer);
  await settle();
  assert.equal(a.last().status, "unavailable");
  assert.equal(a.last().reason, "service");
  subscription.close();
});

test("at most eight viewers per agent; closing the view ends them all", async () => {
  const f = fixture();
  const ended = [];
  const subscriptions = [];
  for (let n = 0; n < 8; n++) {
    const seen = f.viewer();
    seen.viewer.end = () => ended.push(n);
    subscriptions.push(f.live.subscribe("a", seen.viewer));
  }
  assert.throws(() => f.live.subscribe("a", f.viewer().viewer), { code: "LIVE_VIEWERS" });
  await settle();
  f.live.close();
  assert.equal(ended.length, 8);
  assert.equal(f.gateway.sockets[0].closed, true);
});

test("a tab pick during a running refresh is not lost", async () => {
  const f = fixture({
    tabs: [
      { targetId: "t1", title: "One", url: "https://a.example/" },
      { targetId: "t2", title: "Two", url: "https://b.example/" },
    ],
  });
  const a = f.viewer();
  const subscription = f.live.subscribe("a", a.viewer);
  // Picked before the first refresh finished.
  subscription.select("t1");
  await settle();
  assert.equal(f.gateway.tickets.at(-1).targetId, "t1");
  subscription.close();
});

test("an upstream socket that never opens is given up and retried", async () => {
  const f = fixture();
  f.live.openMs = 5;
  const subscription = f.live.subscribe("a", f.viewer().viewer);
  await settle();
  await settle();
  assert.ok(f.gateway.sockets.length >= 2);
  assert.equal(f.gateway.sockets[0].closed, true);
  subscription.close();
});

test("only a full viewer counts as watching", async () => {
  const f = fixture();
  const calls = [];
  f.live.browsers.watched = (id, options) => calls.push(options.full);
  const preview = f.live.subscribe("a", f.viewer().viewer, { preview: true });
  await settle();
  const full = f.live.subscribe("a", f.viewer().viewer);
  await settle();
  full.close();
  f.live.streams.get("a").wake();
  await settle();
  assert.deepEqual([...new Set(calls)], [false, true]);
  assert.equal(calls.at(-1), false);
  preview.close();
});
