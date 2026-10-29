import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { LiveConnection } from "../features/live/live-connection.js";
import { sessionToken } from "./login.js";
import { livePath } from "./socket-access.js";
import { authorizeRequest } from "./security.js";

export const MAX_SOCKETS_PER_PRINCIPAL = 16;
const PING_MS = 30000;

const principalKey = (principal) =>
  principal.role === "user" ? `user:${principal.userId}` : principal.role;

const refuse = (socket, status) =>
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || "Forbidden"}\r\nConnection: close\r\n\r\n`,
  );

/**
 * The live channel, GET /api/live (live-hub.js): one socket per tab, behind the
 * origin check, the login and `admit` like the chat stream. On open the server sends
 * `{type:"hello", instance}`; the client sends `sub`, `unsub`, `ping` and
 * `presence` (live-connection.js). Logout closes with 1008. `changes(listener)` reports access
 * changes (owner privacy, agents), after which every subscription is checked again.
 */
export function attachLiveWebSocket(
  server,
  { hub, login, admit, effective, changes, presence },
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: false,
  });
  // Open sockets per principal; counted when the upgrade completes, which ws does
  // synchronously, so two upgrades cannot both take the last place.
  const open = new Map();
  const upgrade = (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (!livePath.test(url.pathname)) return;
    try {
      authorizeRequest(req, effective(), true);
      const token = sessionToken(req);
      const auth = login.require(token);
      const principal = login.principal(auth);
      admit(principal, { kind: "live" });
      const key = principalKey(principal);
      if ((open.get(key) || 0) >= MAX_SOCKETS_PER_PRINCIPAL) return refuse(socket, 429);
      if (hub.closed) return refuse(socket, 503);
      wss.handleUpgrade(req, socket, head, (ws) => {
        open.set(key, (open.get(key) || 0) + 1);
        wss.emit("connection", ws, { token, auth, principal, key });
      });
    } catch (error) {
      refuse(socket, error.status || 403);
    }
  };
  server.on("upgrade", upgrade);
  const offChanges = changes?.(() => {
    if (!hub.closed) hub.reauthorize();
  });
  wss.once("close", () => {
    server.off("upgrade", upgrade);
    offChanges?.();
  });
  wss.on("connection", (ws, { token, auth, principal, key }) => {
    const connection = new LiveConnection({ ws, hub, principal, presence });
    let alive = true;
    const cleanupLogin = login.watch(auth, () => connection.close(1008));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, PING_MS);
    ping.unref();
    ws.on("pong", () => (alive = true));
    ws.on("error", () => ws.close());
    ws.on("message", (data, isBinary) => {
      alive = true;
      try {
        login.require(token);
      } catch {
        return connection.close(1008);
      }
      if (hub.closed) return connection.close(1012);
      if (isBinary || !connection.receive(data.toString("utf8"))) connection.close(1008);
    });
    ws.on("close", () => {
      clearInterval(ping);
      cleanupLogin();
      connection.close();
      const count = (open.get(key) || 1) - 1;
      if (count) open.set(key, count);
      else open.delete(key);
    });
    if (ws.readyState === WebSocket.OPEN)
      connection.reply({ type: "hello", instance: hub.instance });
  });
  return wss;
}
