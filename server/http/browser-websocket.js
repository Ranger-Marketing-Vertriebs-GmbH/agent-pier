import { sessionToken } from "./login.js";
import { authorizeRequest } from "./security.js";
import { WebSocketServer, WebSocket } from "ws";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
// Frames are dropped, never queued, for a viewer that cannot keep up.
const backlog = 4 * 1024 * 1024;

/**
 * The owner's live view of an agent's browser (browser-live-view.js):
 * /api/assistants/:id/browser-stream, behind the login and the origin check like the
 * chat stream. The server sends JSON state messages and binary frames; the viewer
 * sends small JSON commands (`select`, `follow`, `start`). Input for a takeover would
 * travel the same way.
 */
export function attachBrowserWebSocket(server, { live, login, effective }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const upgrade = (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    const match = url.pathname.match(
      /^\/api\/assistants\/([A-Za-z0-9_-]+)\/browser-stream$/,
    );
    if (!match || !ID.test(match[1])) return;
    try {
      authorizeRequest(req, effective(), true);
      const token = sessionToken(req);
      const auth = login.require(token);
      const view = live();
      if (!view) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, {
          id: match[1],
          token,
          auth,
          view,
          preview: url.searchParams.get("preview") === "1",
        }),
      );
    } catch (error) {
      socket.end(
        `HTTP/1.1 ${error.status || 403} Forbidden\r\nConnection: close\r\n\r\n`,
      );
    }
  };
  server.on("upgrade", upgrade);
  wss.once("close", () => server.off("upgrade", upgrade));
  wss.on("connection", (ws, { id, token, auth, view, preview }) => {
    let alive = true;
    const open = () => ws.readyState === WebSocket.OPEN;
    const send = (message) => open() && ws.send(JSON.stringify(message));
    let subscription;
    try {
      subscription = view.subscribe(
        id,
        {
          state: (state) => send({ type: "state", state }),
          frame: (bytes) => {
            if (open() && ws.bufferedAmount < backlog) ws.send(bytes, { binary: true });
          },
        },
        { preview },
      );
    } catch {
      return ws.close(1008);
    }
    const cleanupLogin = login.watch(auth, () => ws.close(1008));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30000);
    ping.unref();
    ws.on("pong", () => (alive = true));
    ws.on("error", () => ws.close());
    ws.on("message", async (data, binary) => {
      let command;
      try {
        login.require(token);
        if (binary) throw Error("binary");
        command = JSON.parse(String(data));
      } catch {
        return ws.close(1008);
      }
      try {
        if (command?.type === "select") subscription.select(command.targetId);
        else if (command?.type === "follow") subscription.follow();
        else if (command?.type === "start") await subscription.start();
        else ws.close(1008);
      } catch (error) {
        send({ type: "error", message: error.message, key: error.key });
      }
    });
    ws.on("close", () => {
      clearInterval(ping);
      cleanupLogin();
      subscription.close();
    });
  });
  return wss;
}
