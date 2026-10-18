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
