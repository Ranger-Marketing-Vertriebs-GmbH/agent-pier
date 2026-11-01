import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { LoginStore } from "../../server/features/login/login-store.js";
import { previewGate } from "../../server/features/previews/preview-access.js";
import { createPreviewListener } from "../../server/features/previews/preview-proxy.js";
import { freePortRange } from "./preview-ports.js";

// AgentPier's own port as the preview listener sees it; nothing listens there.
export const agentPierPort = 4391;

/** An upstream dev server: records each request, echoes WebSockets. */
export async function startUpstream(t, { host = "127.0.0.1", port = 0, handler } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (handler) return handler(req, res);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${req.method} ${req.url} ${Buffer.concat(chunks)}`);
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, req) => {
    seen.push({ upgrade: true, url: req.url, headers: req.headers });
    socket.on("message", (data) => socket.send(`echo:${data}`));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const close = () =>
    new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  t.after(close);
  return { server, wss, seen, port: server.address().port, close };
}

/**
 * A preview listener on a free slot in front of `upstream`, gated by a real LoginStore.
 * `owner` is a valid owner cookie; `userToken` a restricted user's session.
 */
export async function previewFixture(
  t,
  {
    upstream,
    address = "127.0.0.1",
    config = {},
    detected,
    label = "Shop <b>",
    plainConfig = false,
    gate,
  } = {},
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-preview-proxy-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new LoginStore({ dataDir });
  store.data.user = { username: "fixture", salt: "a".repeat(64), hash: "b".repeat(128) };
  store.save();
  const token = store.issue();
  const userRow = { userId: "u1", hash: "user", expires: Date.now() + 60_000 };
  // One view over the owner's store and one restricted user's session.
  const login = {
    session: (value) => (value === "user-token" ? userRow : store.session(value)),
    require: (value) => (value === "user-token" ? userRow : store.require(value)),
    watch: (row, close) => (row === userRow ? () => {} : store.watch(row, close)),
  };
  const { start: slot } = await freePortRange(1);
  const current = {
    port: agentPierPort,
    network: { enabled: false, bind: "127.0.0.1", hosts: [] },
    ...config,
  };
  // The config as a function (like the app's effective()) or as a plain object.
  const effective = plainConfig ? current : () => current;
  const state = {
    preview: { id: "p1", slot, target: upstream.port, label },
    address,
    alive: true,
    touched: 0,
  };
  const listener = await createPreviewListener({
    slot,
    host: "127.0.0.1",
    gate: gate || previewGate({ login, effective, slot, detected }),
    watch: (session, close) => login.watch(session, close),
    resolve: (asked) =>
      asked === slot && state.alive
        ? { preview: state.preview, address: state.address }
        : null,
    touch: (preview) => {
      if (preview === state.preview) state.touched++;
    },
    effective,
  });
  t.after(() => listener.close());
  return {
    store,
    token,
    slot,
    state,
    listener,
    owner: `agentpier_session=${token}`,
    host: `127.0.0.1:${slot}`,
  };
}

/** One HTTP request to the slot with full control over Host and the other headers. */
export function send(slot, { method = "GET", path: url = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: slot, method, path: url, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** A WebSocket through the slot; resolves once open, rejects on a refused upgrade. */
export function openSocket(slot, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${slot}/hmr`, { headers });
    socket.once("upgrade", (res) => (socket.handshake = res.headers));
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_req, res) =>
      reject(Object.assign(new Error("refused"), { status: res.statusCode })),
    );
    socket.once("error", reject);
  });
}
