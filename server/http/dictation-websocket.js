import http from "node:http";
import { sessionToken } from "./login.js";
import { authorizeRequest } from "./security.js";
import { WebSocketServer, WebSocket } from "ws";

export const dictationPath = "/api/dictation/stream";

/**
 * The owner's live dictation (dictation-service.js): /api/dictation/stream, behind
 * the login and the origin check like the chat stream. The browser sends binary
 * frames of 16 kHz mono PCM and `{"type":"stop"}`; the server answers with JSON
 * messages: `ready`, `transcript` (interim or final), `ended` and `error` codes.
 */
export function attachDictationWebSocket(server, { dictation, login, effective }) {
  // About two seconds of audio per frame at most.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const upgrade = (req, socket, head) => {
    if (new URL(req.url, "http://localhost").pathname !== dictationPath) return;
    try {
      authorizeRequest(req, effective(), true);
      const token = sessionToken(req);
      const auth = login.require(token);
      const service = dictation();
      if (!service) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, { auth, service }),
      );
    } catch (error) {
      const status = error.status || 403;
      socket.end(
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || "Forbidden"}\r\nConnection: close\r\n\r\n`,
      );
    }
  };
  server.on("upgrade", upgrade);
  wss.once("close", () => server.off("upgrade", upgrade));
  wss.on("connection", (ws, { auth, service }) => {
    let session = null;
    const client = {
      send: (message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
      close: (code) => {
        if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(ws.readyState))
          ws.close(code);
      },
    };
    const cleanupLogin = login.watch(auth, () => {
      ws.close(1008);
      session?.abort();
    });
    ws.on("error", () => ws.close());
    ws.on("close", () => {
      cleanupLogin();
      session?.abort();
    });
    ws.on("message", (data, binary) => {
      if (binary) return session.audio(Buffer.isBuffer(data) ? data : Buffer.from(data));
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {}
      if (message?.type === "stop") return session.stop();
      ws.close(1008);
      session.abort();
    });
    session = service.start({ holder: auth.hash, client });
  });
  return wss;
}
