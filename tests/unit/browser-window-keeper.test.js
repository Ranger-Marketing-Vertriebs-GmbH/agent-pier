import test from "node:test";
import assert from "node:assert/strict";
import { BrowserWindowKeeper } from "../../server/features/assistants/browser-window-keeper.js";

// The keeper never holds the process open; the tests do while they wait.
const hold = setInterval(() => {}, 1000);
test.after(() => clearInterval(hold));

test("a browser that never comes up ends the watch and reports it", async () => {
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
});

test("a browser already running is watched without minimizing its windows", async () => {
  let closed = 0;
  const keeper = new BrowserWindowKeeper(1, {
    // Answers at once; the socket then fails, which also ends the watch.
    fetch: async () => ({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/browser/x" }),
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
});

test("a CDP call the browser never answers fails within its timeout", async () => {
  const keeper = new BrowserWindowKeeper(1);
  const sent = [];
  keeper.ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
  keeper.known.add(7);
  const started = Date.now();
  assert.equal(await keeper.inUse(), false);
  assert.ok(Date.now() - started < 5000);
  assert.equal(sent[0].method, "Browser.getWindowBounds");
  assert.equal(keeper.pending.size, 0);
});
