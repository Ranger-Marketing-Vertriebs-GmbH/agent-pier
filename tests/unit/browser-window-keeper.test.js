import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { BrowserWindowKeeper } from "../../server/features/assistants/browser-window-keeper.js";

// The keeper never holds the process open (its timers are unref'd); each test holds
// it while it waits, and a timeout ends a test that never settles instead of a run
// that waits forever (a file-wide interval once kept a hung file alive for hours).
const options = { timeout: 15000 };
async function held(work) {
  const hold = setInterval(() => {}, 1000);
  try {
    return await work();
  } finally {
    clearInterval(hold);
  }
}
// A loopback port nothing listens on: taken, then released.
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a browser that never comes up ends the watch and reports it", options, () =>
  held(async () => {
    let closed = 0;
    const keeper = new BrowserWindowKeeper(1, {
      timeoutMs: 600,
      fetch: async () => {
        throw Error("refused");
      },
      onClose: () => closed++,
    });
    assert.equal(await keeper.start(), false);
    assert.equal(closed, 1);
  }),
);

test("a browser already running is watched without minimizing its windows", options, () =>
  held(async () => {
    let closed = 0;
    const port = await closedPort();
    const keeper = new BrowserWindowKeeper(1, {
      // Answers at once; the socket then fails, which also ends the watch.
      fetch: async () => ({
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x`,
        }),
      }),
      onClose: () => closed++,
    });
    assert.equal(await keeper.start(), false);
    assert.equal(keeper.launchedAt, null);
    assert.equal(closed, 1);
    // A close AgentPier asked for is not reported.
    const asked = new BrowserWindowKeeper(1, { onClose: () => closed++ });
    asked.close();
    assert.equal(await asked.start(), false);
    assert.equal(closed, 1);
  }),
);

test("a CDP call the browser never answers fails within its timeout", options, () =>
  held(async () => {
    const keeper = new BrowserWindowKeeper(1);
    const sent = [];
    keeper.ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
    keeper.known.add(7);
    assert.equal(await keeper.inUse(), false);
    assert.equal(sent[0].method, "Browser.getWindowBounds");
    assert.equal(keeper.pending.size, 0);
  }),
);

// A browser over a fake socket: answers each CDP call from `reply` and records it.
function fakeBrowser(keeper, reply) {
  const sent = [];
  keeper.ws = {
    readyState: 1,
    send: (data) => {
      const msg = JSON.parse(data);
      sent.push(msg);
      queueMicrotask(() =>
        keeper.message(JSON.stringify({ id: msg.id, result: reply(msg) || {} })),
      );
    },
    close() {},
  };
  return sent;
}

test("a fresh launch's window is parked, never minimized", options, () =>
  held(async () => {
    let clock = 1000;
    const keeper = new BrowserWindowKeeper(1, { now: () => clock });
    keeper.launchedAt = clock;
    // The window manager clamps the position into the screen's corner.
    let bounds = { left: 22, top: 52, width: 1200, height: 900, windowState: "normal" };
    const sent = fakeBrowser(keeper, (msg) => {
      if (msg.method === "Target.attachToTarget") return { sessionId: "s" };
      if (msg.method === "Browser.getWindowForTarget") return { windowId: 7 };
      if (msg.method === "Browser.setWindowBounds" && "left" in msg.params.bounds)
        bounds = { ...bounds, left: 1880, top: 949 };
      if (msg.method === "Browser.getWindowBounds") return { bounds };
    });
    await keeper.page({ type: "page", targetId: "t1" });
    const methods = sent.map((m) => m.method);
    assert.ok(methods.includes("Emulation.setFocusEmulationEnabled"));
    const sets = sent.filter((m) => m.method === "Browser.setWindowBounds");
    assert.deepEqual(
      sets.map((m) => m.params.bounds),
      [{ windowState: "normal" }, { left: 100000, top: 100000 }],
    );
    assert.equal(
      sent.some((m) => m.params?.bounds?.windowState === "minimized"),
      false,
    );
    // Parked, the window is not the owner's; moved, maximized or resized it is.
    assert.equal(await keeper.inUse(), false);
    bounds = { ...bounds, left: 300, top: 200 };
    assert.equal(await keeper.inUse(), true);
    bounds = { ...bounds, windowState: "maximized" };
    assert.equal(await keeper.inUse(), true);
    bounds = { ...bounds, windowState: "minimized" };
    assert.equal(await keeper.inUse(), false);
    // A window opened after the launch window is left where it opened.
    clock += 20000;
    sent.length = 0;
    await keeper.page({ type: "page", targetId: "t2" });
    assert.equal(
      sent.some((m) => m.method === "Browser.setWindowBounds"),
      false,
    );
  }),
);

test(
  "a fresh launch's bootstrap browser ending early waits for the real one",
  options,
  () =>
    held(async () => {
      let closed = 0;
      const keeper = new BrowserWindowKeeper(1, { onClose: () => closed++ });
      const starts = [];
      keeper.start = async (options) => starts.push(options);
      const first = { close() {} };
      keeper.ws = first;
      keeper.launchedAt = Date.now();
      keeper.known.add(3);
      keeper.lost(first);
      assert.deepEqual(starts, [{ fresh: true }]);
      assert.equal(closed, 0);
      assert.equal(keeper.known.size, 0);
      // Only once: the next end is the browser's.
      const second = { close() {} };
      keeper.ws = second;
      keeper.lost(second);
      assert.equal(closed, 1);
      assert.equal(starts.length, 1);
    }),
);
