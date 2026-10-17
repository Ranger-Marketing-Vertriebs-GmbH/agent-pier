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
    request: async (_method, { method, path, body }) => {
      if (path === "/") return { running: true };
      if (path === "/tabs")
        return {
          tabs: [
            { targetId: "t1", title: "One", url: "https://a.example/" },
            { targetId: "t2", title: "Two", url: "https://b.example/" },
          ],
        };
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
  return { client, tickets, connected };
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
