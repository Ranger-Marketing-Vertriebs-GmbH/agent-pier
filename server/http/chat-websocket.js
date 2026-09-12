import { sessionToken } from "./login.js";
import { authorizeRequest } from "./security.js";
import { WebSocketServer, WebSocket } from "ws";
import { ChatSync } from "../features/chat/chat-sync.js";

export function attachChatWebSocket(server, { sessions, streams, login, effective }) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
  });
  const sync = new ChatSync({ sessions });
  const upgrade = (req, socket, head) => {
    const match = new URL(req.url, "http://localhost").pathname.match(
      /^\/api\/sessions\/([a-zA-Z0-9_-]+)\/chat-stream$/,
    );
    if (!match) return;
    try {
      authorizeRequest(req, effective(), true);
      const token = sessionToken(req);
      const auth = login.require(token);
      if (streams.closed) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, { id: match[1], token, auth });
      });
    } catch (error) {
      socket.end(
        `HTTP/1.1 ${error.status || 403} Forbidden\r\nConnection: close\r\n\r\n`,
      );
    }
  };
  server.on("upgrade", upgrade);
  wss.once("close", () => server.off("upgrade", upgrade));
  wss.on("connection", (ws, { id, token, auth }) => {
    let closed = false,
      alive = true,
      sequence = 0,
      cursor;
    const send = (message) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 2 * 1024 * 1024) return ws.close(1013);
      ws.send(JSON.stringify(message));
    };
    const cleanupLogin = login.watch(auth, () => ws.close(1008));
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
      unsubscribe?.();
    });
    unsubscribe = streams.subscribe(id, ({ session, snapshot, error }) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      try {
        login.require(token);
        if (error) {
          send({ type: "error", message: error.message });
          if ([403, 404].includes(error.status)) ws.close(1008);
          return;
        }
        const data = sync.encode(session, snapshot, cursor);
        cursor = data.sync.cursor;
        send({ type: "sync", sequence: ++sequence, data });
        if (
          session.status !== "running" &&
          snapshot.availability === "ready" &&
          !snapshot.observability?.stale &&
          !snapshot.history?.indexing
        )
          send({ type: "ended" });
      } catch {
        ws.close(1008);
      }
    });
  });
  return wss;
}
