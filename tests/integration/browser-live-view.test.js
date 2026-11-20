import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { applicationFixture } from "../helpers/application.js";
import { BrowserLiveView } from "../../server/features/assistants/browser-live-view.js";

// A stand-in for the Gateway: browser.request answers and the screencast socket,
// which sends OpenClaw's ready message and one binary frame per ticket.
async function fakeGateway(t) {
  const tickets = [];
  // The takeover toolbar's calls: navigation and tab routes.
  const calls = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const connected = [];
  wss.on("connection", (ws, req) => {
    const token = new URL(req.url, "http://x").searchParams.get("token");
    connected.push(token);
    ws.send(
      JSON.stringify({
        type: "ready",
        targetId: "t1",
        url: "https://a.example/",
        title: "One",
      }),
    );
    const header = Buffer.from(
      JSON.stringify({ url: "https://a.example/", cssWidth: 800, cssHeight: 600 }),
    );
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    ws.send(Buffer.concat([length, header, Buffer.from([0xff, 0xd8, 0xff, 0xd9])]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => server.close(r));
  });
  const base = `ws://127.0.0.1:${server.address().port}`;
  const client = {
    ready: true,
    request: async (_method, { method, path, query, body }) => {
      if (path === "/") return { running: true };
      if (path === "/tabs")
        return {
          tabs: [
            { targetId: "t1", title: "One", url: "https://a.example/" },
            { targetId: "t2", title: "Two", url: "https://b.example/" },
          ],
        };
      if (["/navigate", "/tabs/focus"].includes(path) || method === "DELETE") {
        calls.push({ method, path, query, body });
        return { ok: true };
      }
      if (method === "POST" && path === "/screencast") {
        tickets.push(body);
        const token = `token-${tickets.length}`;
        return {
          token,
          wsPath: `/browser/screencast?token=${token}`,
          targetId: body.targetId || "t1",
        };
      }
      throw Error(path);
    },
    openStream: (wsPath) => new WebSocket(base + wsPath),
  };
  return { client, tickets, connected, calls };
}

test("the owner watches an agent's browser through the authenticated stream", async (t) => {
  const gateway = await fakeGateway(t);
  const f = await applicationFixture(t);
  const live = new BrowserLiveView({
    browsers: {
      viewProfile: () => ({ name: "agent-a", entry: { headless: false } }),
      watched: () => {},
      ownerStart: async () => {},
    },
    runtime: { client: gateway.client },
    pollMs: 60_000,
    retryMs: 50,
  });
  t.after(() => live.close());
  f.application.assistants = { liveView: live, close: async () => {} };
  const address = `${f.url.replace("http:", "ws:")}/api/assistants/a/browser-stream`;
  // Without the login cookie, or from a foreign origin, nothing is streamed.
  for (const options of [
    { origin: f.url },
    { origin: "https://evil.example", headers: { cookie: f.cookie } },
  ]) {
    const refused = new WebSocket(address, options);
    const status = await new Promise((resolve) => {
      refused.on("unexpected-response", (_req, res) => {
        // The status line names the status itself, not always "Forbidden".
        assert.equal(res.statusMessage, http.STATUS_CODES[res.statusCode]);
        resolve(res.statusCode);
      });
      refused.on("open", () => resolve("open"));
      refused.on("error", () => {});
    });
    assert.notEqual(status, "open");
  }
  const ws = new WebSocket(address, { origin: f.url, headers: { cookie: f.cookie } });
  const states = [],
    frames = [];
  ws.on("message", (data, binary) =>
    binary ? frames.push(Buffer.from(data)) : states.push(JSON.parse(String(data)).state),
  );
  await new Promise((r) => ws.on("open", r));
  const until = async (check) => {
    for (let n = 0; n < 200 && !check(); n++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(check());
  };
  await until(() => frames.length === 1 && states.at(-1)?.status === "live");
  // The frame arrives exactly as the Gateway sent it: header length, header, JPEG.
  assert.equal(frames[0].readUInt32BE(0) + 4 + 4, frames[0].length);
  assert.deepEqual([...frames[0].subarray(-4)], [0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(states.at(-1).title, "One");
  assert.deepEqual(
    states.at(-1).tabs.map((tab) => tab.targetId),
    ["t1", "t2"],
  );
  assert.deepEqual(gateway.connected, ["token-1"]);
  // The owner picks the other tab: a fresh ticket for it.
  ws.send(JSON.stringify({ type: "select", targetId: "t2" }));
  await until(() => gateway.tickets.length === 2);
  assert.equal(gateway.tickets[1].targetId, "t2");
  await until(() => states.at(-1).pinned === true);
  // Binary input is not accepted.
  ws.send(Buffer.from([1, 2, 3]));
  await new Promise((r) => ws.on("close", r));
  await until(() => live.streams.size === 0);
});

// A stand-in for the agent browser's CDP port: /json/version and a browser socket
// that attaches to tabs and records every Input event.
async function fakeCdp(t) {
  const events = [];
  const server = http.createServer((req, res) => {
    if (req.url !== "/json/version") return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/x`,
      }),
    );
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) =>
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      events.push(message);
      const result =
        message.method === "Target.attachToTarget"
          ? { sessionId: "S1" }
          : message.method === "Page.getNavigationHistory"
            ? {
                currentIndex: 1,
                entries: [
                  { id: 5, url: "https://start.example/" },
                  { id: 6, url: "https://a.example/" },
                ],
              }
            : {};
      ws.send(JSON.stringify({ id: message.id, result }));
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => server.close(r));
  });
  return { port: server.address().port, events };
}

test("the owner takes over: input goes to the agent's tab over CDP, then hands back", async (t) => {
  const gateway = await fakeGateway(t);
  const cdp = await fakeCdp(t);
  const f = await applicationFixture(t);
  const handBacks = [];
  const live = new BrowserLiveView({
    browsers: {
      viewProfile: () => ({
        name: "agent-a",
        entry: { headless: false, cdpPort: cdp.port },
      }),
      viewReason: () => "noProfile",
      watched: () => {},
      ownerStart: async () => {},
    },
    runtime: { client: gateway.client },
    pollMs: 60_000,
    retryMs: 50,
    onHandBack: (id, reason) => handBacks.push([id, reason]),
  });
  t.after(() => live.close());
  f.application.assistants = { liveView: live, close: async () => {} };
  const ws = new WebSocket(
    `${f.url.replace("http:", "ws:")}/api/assistants/a/browser-stream`,
    {
      origin: f.url,
      headers: { cookie: f.cookie },
    },
  );
  const states = [];
  ws.on("message", (data, binary) => !binary && states.push(JSON.parse(String(data))));
  await new Promise((r) => ws.on("open", r));
  const until = async (check) => {
    for (let n = 0; n < 200 && !check(); n++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(check());
  };
  const last = () => states.filter((m) => m.type === "state").at(-1)?.state;
  await until(() => last()?.status === "live");
  assert.deepEqual(last().control, { held: false, mine: false });
  ws.send(JSON.stringify({ type: "take" }));
  await until(() => last().control.mine === true);
  // The holder hash never reaches the page.
  assert.equal(last().control.holder, undefined);
  ws.send(
    JSON.stringify({
      type: "pointer",
      action: "down",
      x: 0.5,
      y: 0.25,
      button: "left",
      buttons: 1,
      clickCount: 1,
    }),
  );
  ws.send(JSON.stringify({ type: "text", text: "Hallo" }));
  await until(
    () => cdp.events.filter((e) => e.method?.startsWith("Input.")).length === 2,
  );
  const attach = cdp.events.find((e) => e.method === "Target.attachToTarget");
  assert.deepEqual(attach.params, { targetId: "t1", flatten: true });
  const [mouse, text] = cdp.events.filter((e) => e.method?.startsWith("Input."));
  assert.equal(mouse.sessionId, "S1");
  // 800 × 600 from the frame header: half the width, a quarter of the height.
  assert.deepEqual(
    [mouse.params.x, mouse.params.y, mouse.params.type],
    [400, 150, "mousePressed"],
  );
  assert.deepEqual(text.params, { text: "Hallo" });
  // The agent tried the browser meanwhile, so the hand-back reaches it.
  live.refused("a");
  ws.send(JSON.stringify({ type: "handBack" }));
  await until(() => last().control.held === false);
  assert.deepEqual(handBacks, [["a", "owner"]]);
  ws.close();
});

test("the holder's browser toolbar navigates, goes back, reloads and switches tabs", async (t) => {
  const gateway = await fakeGateway(t);
  const cdp = await fakeCdp(t);
  const f = await applicationFixture(t);
  const live = new BrowserLiveView({
    browsers: {
      viewProfile: () => ({
        name: "agent-a",
        entry: { headless: false, cdpPort: cdp.port },
      }),
      viewReason: () => "noProfile",
      watched: () => {},
    },
    runtime: { client: gateway.client },
    pollMs: 60_000,
    retryMs: 50,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  t.after(() => live.close());
  f.application.assistants = { liveView: live, close: async () => {} };
  const ws = new WebSocket(
    `${f.url.replace("http:", "ws:")}/api/assistants/a/browser-stream`,
    {
      origin: f.url,
      headers: { cookie: f.cookie },
    },
  );
  const messages = [];
  ws.on("message", (data, binary) => !binary && messages.push(JSON.parse(String(data))));
  await new Promise((r) => ws.on("open", r));
  const until = async (check) => {
    for (let n = 0; n < 200 && !check(); n++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(check());
  };
  const last = () => messages.filter((m) => m.type === "state").at(-1)?.state;
  const errors = () => messages.filter((m) => m.type === "error").map((m) => m.code);
  await until(() => last()?.status === "live");
  // Watching only: the toolbar's commands are refused.
  ws.send(JSON.stringify({ type: "navigate", action: "go", url: "b.example" }));
  await until(() => errors().includes("NOT_HOLDER"));
  assert.equal(gateway.calls.length, 0);
  ws.send(JSON.stringify({ type: "take" }));
  await until(() => last().control.mine === true);
  ws.send(JSON.stringify({ type: "navigate", action: "go", url: "b.example/x" }));
  await until(() => gateway.calls.length === 1);
  assert.deepEqual(gateway.calls[0], {
    method: "POST",
    path: "/navigate",
    query: { profile: "agent-a" },
    body: { url: "https://b.example/x", targetId: "t1" },
  });
  // The private-network rule of the agent browser: a loopback address is refused.
  ws.send(
    JSON.stringify({ type: "navigate", action: "go", url: "http://127.0.0.1:4380/" }),
  );
  await until(() => errors().includes("NAVIGATION_BLOCKED"));
  assert.equal(gateway.calls.length, 1);
  ws.send(JSON.stringify({ type: "navigate", action: "back" }));
  ws.send(JSON.stringify({ type: "navigate", action: "reload" }));
  const page = () =>
    cdp.events
      .filter((e) => e.method?.startsWith("Page."))
      .map((e) => [e.method, e.params]);
  await until(() => page().length === 3);
  assert.deepEqual(page(), [
    ["Page.getNavigationHistory", {}],
    ["Page.navigateToHistoryEntry", { entryId: 5 }],
    ["Page.reload", {}],
  ]);
  assert.ok(
    cdp.events
      .filter((e) => e.method?.startsWith("Page."))
      .every((e) => e.sessionId === "S1"),
  );
  // The sign-in tab: brought to the front and shown, then closed.
  ws.send(JSON.stringify({ type: "tab", action: "switch", targetId: "t2" }));
  await until(() => gateway.tickets.at(-1)?.targetId === "t2");
  assert.deepEqual(gateway.calls[1].path, "/tabs/focus");
  assert.deepEqual(gateway.calls[1].body, { targetId: "t2" });
  ws.send(JSON.stringify({ type: "tab", action: "close", targetId: "t2" }));
  await until(() => gateway.calls.length === 3);
  assert.deepEqual(gateway.calls[2], {
    method: "DELETE",
    path: "/tabs/t2",
    query: { profile: "agent-a", targetIdMode: "raw" },
    body: undefined,
  });
  // An unknown command still closes the socket.
  ws.send(JSON.stringify({ type: "navigate-everything" }));
  await new Promise((r) => ws.on("close", r));
});
