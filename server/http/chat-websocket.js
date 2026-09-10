import { sessionToken } from "./login.js";
import { authorizeRequest } from "./security.js";
import { serverMessages } from "../lib/i18n/de.js";
import { WebSocketServer, WebSocket } from "ws";
import { problem } from "../lib/storage.js";

export function attachChatWebSocket(
  server,
  { sessions, chat, chatImages, events, login, effective },
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    try {
      authorizeRequest(req, effective(), true);
      const authSession = login.require(sessionToken(req));
      const match = new URL(req.url, "http://localhost").pathname.match(
        /^\/api\/sessions\/([a-zA-Z0-9-]+)\/chat-stream$/,
      );
      if (!match) throw problem(serverMessages.http.notFound, 404);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.sessionId = match[1];
        ws.authSession = authSession;
        ws.authToken = sessionToken(req);
        wss.emit("connection", ws);
      });
    } catch (error) {
      socket.end(
        `HTTP/1.1 ${error.status || 403} Forbidden\r\nConnection: close\r\n\r\n`,
      );
    }
  });
  wss.on("connection", (ws) => {
    let closed = false;
    let alive = true;
    const send = (message) => {
      if (!closed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const cleanupLogin = login.watch(ws.authSession, () => ws.close(1008));
    const ping = setInterval(
      () => (alive ? ((alive = false), ws.ping()) : ws.terminate()),
      30000,
    );
    ping.unref();
    ws.on("pong", () => (alive = true));
    ws.on("close", () => {
      closed = true;
      clearInterval(ping);
      cleanupLogin();
      unsubscribe?.();
    });
    let unsubscribe;
    (async () => {
      try {
        const session = await sessions.get(ws.sessionId);
        login.require(ws.authToken);
        const snapshot = await chatImages.decorate(
          ws.sessionId,
          await chat.read(ws.sessionId),
        );
        send({ type: "snapshot", sequence: events.current(ws.sessionId), snapshot });
        unsubscribe = events.subscribe(ws.sessionId, (event) =>
          send({ type: "event", event }),
        );
        if (session.status !== "running") send({ type: "ended" });
      } catch (error) {
        send({ type: "error", message: error.message });
        ws.close(1011);
      }
    })();
  });
  return wss;
}
