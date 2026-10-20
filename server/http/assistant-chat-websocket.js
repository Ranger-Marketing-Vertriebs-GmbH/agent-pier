import http from "node:http";
import { messageIdentity } from "../lib/i18n/message-identity.js";
import { sessionToken } from "./login.js";
import { agentChatPath } from "./socket-access.js";
import { authorizeRequest } from "./security.js";
import { WebSocketServer, WebSocket } from "ws";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
// A viewer that falls this far behind reconnects and resumes from its cursor.
const backlog = 2 * 1024 * 1024;

/**
 * An agent chat's live feed (conversation-feeds.js):
 * /api/assistant-conversations/:id/stream?cursor=…, behind the login and the origin
 * check like the session chat stream. The server sends `sync` frames (history
 * diffs against the client's cursor) and `stream` frames (the reply streaming now);
 * the client sends nothing.
 */
export function attachAssistantChatWebSocket(
  server,
  { assistants, login, admit, effective },
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true },
  });
  const refuse = (socket, status) =>
    socket.end(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || "Forbidden"}\r\nConnection: close\r\n\r\n`,
    );
  const upgrade = (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    const match = url.pathname.match(agentChatPath);
    if (!match) return;
    try {
      authorizeRequest(req, effective(), true);
      const token = sessionToken(req);
      const auth = login.require(token);
      if (!ID.test(match[1])) return refuse(socket, 404);
      const principal = login.principal(auth);
      const target = { kind: "agent-chat", id: match[1] };
      admit(principal, target);
      const service = assistants();
      if (!service || service.closed || service.feeds.closed) return refuse(socket, 503);
      // Only a conversation of the owner's own agents (the history route's check).
      service.store.getConversation(match[1]);
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, {
          id: match[1],
          token,
          auth,
          feeds: service.feeds,
          events: service.events,
          // Admission again: an unassigned user or a withdrawn opt-in closes it.
          admitted: () => {
            try {
              admit(principal, target);
              return true;
            } catch {
              return false;
            }
          },
          cursor: url.searchParams.get("cursor") || undefined,
        }),
      );
    } catch (error) {
      refuse(socket, error.status || 403);
    }
  };
  server.on("upgrade", upgrade);
  wss.once("close", () => server.off("upgrade", upgrade));
  wss.on("connection", (ws, { id, token, auth, feeds, events, admitted, cursor }) => {
    let closed = false,
      alive = true,
      sequence = 0;
    const send = (message) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > backlog) return ws.close(1013);
      ws.send(JSON.stringify(message));
    };
    const cleanupLogin = login.watch(auth, () => ws.close(1008));
    // Every agent change (an assignment among them) checks the viewer's access again.
    const unwatch = events.subscribe(() => {
      if (!admitted()) ws.close(1008);
    });
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30000);
    ping.unref();
    let unsubscribe;
    ws.on("pong", () => (alive = true));
    ws.on("error", () => ws.close());
    ws.on("message", () => ws.close(1008));
    ws.on("close", () => {
      closed = true;
      clearInterval(ping);
      cleanupLogin();
      unwatch();
      unsubscribe?.();
    });
    const frame = (event) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      try {
        login.require(token);
      } catch {
        return ws.close(1008);
      }
      if (!admitted()) return ws.close(1008);
      if (event.type === "end") return ws.close(1001);
      if (event.type === "error") {
        const { message, status } = event.error || {};
        send({ type: "error", message, ...messageIdentity(message) });
        if ([403, 404].includes(status)) ws.close(1008);
        return;
      }
      if (event.type === "sync")
        return send({ type: "sync", sequence: ++sequence, data: event.data });
      send(event);
    };
    try {
      unsubscribe = feeds.subscribe(id, { cursor }, frame);
    } catch {
      ws.close(1001);
    }
  });
  return wss;
}
