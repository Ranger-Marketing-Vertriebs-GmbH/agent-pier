import { sessionToken } from "./login.js";
import { serverMessages } from "../lib/i18n/de.js";
import { WebSocketServer, WebSocket } from "ws";
import { authorizeRequest } from "./security.js";
import { problem } from "../lib/storage.js";
export function attachTerminalWebSocket(server, { sessions, login, effective }) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (/^\/api\/sessions\/[a-zA-Z0-9_-]+\/chat-stream$/.test(pathname)) return;
    try {
      authorizeRequest(req, effective(), true);
      const authSession = login.require(sessionToken(req));
      const match = new URL(req.url, "http://localhost").pathname.match(
        /^\/api\/sessions\/([a-zA-Z0-9-]+)\/terminal$/,
      );
      if (!match) throw problem(serverMessages.http.notFound, 404);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.sessionId = match[1];
        ws.authSession = authSession;
        ws.authToken = sessionToken(req);
        wss.emit("connection", ws);
      });
    } catch (e) {
      socket.end(`HTTP/1.1 ${e.status || 403} Forbidden\r\nConnection: close\r\n\r\n`);
    }
  });
  wss.on("connection", (ws) => {
    let attachment;
    let closed = false;
    let queue = Promise.resolve();
    let alive = true;
    const cleanupLogin = login.watch(ws.authSession, () => {
      closed = true;
      attachment?.dispose();
      attachment = null;
      ws.close(1008);
    });
    const send = (msg) => {
      if (!closed && ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > 2 * 1024 * 1024) {
          ws.close(1013, serverMessages.http.connectionTooSlow);
          return;
        }
        ws.send(JSON.stringify(msg));
      }
    };
    const ping = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 30000);
    ping.unref();
    ws.on("pong", () => (alive = true));
    ws.on("close", () => {
      closed = true;
      clearInterval(ping);
      cleanupLogin();
      attachment?.dispose();
    });
    ws.on("error", () => ws.close());
    const ready = (async () => {
      try {
        const session = await sessions.get(ws.sessionId);
        if (closed) return;
        login.require(ws.authToken);
        send({ type: "status", status: session.status });
        if (session.status !== "running") {
          send({
            type: "output",
            data: (await sessions.screen(ws.sessionId)).replace(/\n/g, "\r\n"),
          });
          return;
        }
        attachment = await sessions.attach(ws.sessionId, {
          cols: 100,
          rows: 30,
          onData: (data) => send({ type: "output", data }),
          onExit: () => {
            send({ type: "status", status: "exited" });
          },
        });
        if (closed) attachment.dispose();
      } catch (e) {
        send({ type: "error", message: e.message });
        ws.close(1008);
      }
    })();
    ws.on("message", (raw) => {
      queue = queue
        .then(async () => {
          await ready;
          if (closed) return;
          login.require(ws.authToken);
          let msg;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            throw problem(serverMessages.http.invalidMessage);
          }
          if (msg.type === "input") {
            if (typeof msg.data !== "string" || msg.data.length > 32000)
              throw problem("Eingabe zu lang.");
            if (!attachment) throw problem(serverMessages.http.sessionStopped);
            await attachment.write(msg.data);
          } else if (msg.type === "resize") {
            if (
              !Number.isInteger(msg.cols) ||
              !Number.isInteger(msg.rows) ||
              msg.cols < 20 ||
              msg.cols > 500 ||
              msg.rows < 5 ||
              msg.rows > 200
            )
              throw problem(serverMessages.http.invalidTerminalSize);
            attachment?.resize(msg.cols, msg.rows);
          } else throw problem(serverMessages.http.unknownTerminalMessage);
        })
        .catch((e) => send({ type: "error", message: e.message }));
    });
  });
  return wss;
}
