import http from "node:http";
import { sessionToken } from "./login.js";
import { browserPath } from "./socket-access.js";
import { authorizeRequest } from "./security.js";
import { WebSocketServer, WebSocket } from "ws";
import { createHash } from "node:crypto";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
// Frames are dropped, never queued, for a viewer that cannot keep up.
const backlog = 4 * 1024 * 1024;
// Owner input: a burst for a fast drag or paste, then this many messages a second.
const inputBurst = 240,
  inputRate = 120;
const inputTypes = new Set(["pointer", "wheel", "key", "text", "paste"]);
const controls = new Set(["start", "take", "handBack"]);
/** The viewer's view of the shared state: whether this login session holds control. */
export function personalState(state, holder) {
  const { control, ...rest } = state;
  return {
    ...rest,
    control: control
      ? {
          held: true,
          mine: control.holder === holder,
          warning: control.warning,
          expiresAt: control.expiresAt,
        }
      : { held: false, mine: false },
  };
}

/**
 * The owner's live view of an agent's browser (browser-live-view.js):
 * /api/assistants/:id/browser-stream, behind the login and the origin check like the
 * chat stream. The server sends JSON state messages and binary frames; the viewer
 * sends small JSON commands (`select`, `follow`, `start`). Input for a takeover would
 * travel the same way.
 */
export function attachBrowserWebSocket(
  server,
  { live, login, admit, effective, changes },
) {
  // A paste of up to 4000 characters fits, encoded.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  const upgrade = (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    const match = url.pathname.match(browserPath);
    if (!match || !ID.test(match[1])) return;
    try {
      authorizeRequest(req, effective(), true);
      const token = sessionToken(req);
      const auth = login.require(token);
      const principal = login.principal(auth);
      const target = { kind: "browser", id: match[1] };
      const access = admit(principal, target) || {};
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
          viewOnly: access.viewOnly === true,
          // Admission again: the browser changed hands, an opt-in ended or a shared
          // agent became a user's own. A view admitted to drive that may now only watch
          // is closed too; it reconnects view-only.
          admitted: () => {
            try {
              const now = admit(principal, target) || {};
              return (now.viewOnly === true) === (access.viewOnly === true);
            } catch {
              return false;
            }
          },
        }),
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
  wss.on("connection", (ws, { id, token, auth, view, preview, viewOnly, admitted }) => {
    let alive = true;
    // The login session holds a takeover lease; never the token itself.
    const holder = createHash("sha256").update(`browser-holder\0${token}`).digest("hex");
    let tokens = inputBurst,
      refilled = Date.now();
    const allowInput = () => {
      const now = Date.now();
      tokens = Math.min(inputBurst, tokens + ((now - refilled) / 1000) * inputRate);
      refilled = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };
    const open = () => ws.readyState === WebSocket.OPEN;
    const send = (message) => open() && ws.send(JSON.stringify(message));
    let subscription;
    try {
      subscription = view.subscribe(
        id,
        {
          state: (state) => send({ type: "state", state: personalState(state, holder) }),
          frame: (bytes) => {
            if (open() && ws.bufferedAmount < backlog) ws.send(bytes, { binary: true });
          },
          // The live view shut down (AgentPier stopping or the agent feature off).
          end: () => ws.close(1001),
        },
        { preview, holder },
      );
    } catch (error) {
      // Too many viewers of this agent: try again later.
      return ws.close(error?.code === "LIVE_VIEWERS" ? 1013 : 1008);
    }
    const cleanupLogin = login.watch(auth, () => ws.close(1008));
    const recheck = () => {
      if (!admitted()) ws.close(1008);
    };
    const unwatchDrivers = view.watchDrivers?.((agentId) => {
      if (agentId === id) recheck();
    });
    const unwatchAccess = changes?.(recheck);
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
        // A view-only viewer (the owner on a user's own agent) never takes, types
        // or starts anything; he follows and switches tabs of the view only.
        if (viewOnly && !["select", "follow"].includes(command?.type)) {
          if (!inputTypes.has(command?.type) && !controls.has(command?.type))
            return ws.close(1008);
          return send({ type: "error", code: "VIEW_ONLY" });
        }
        if (inputTypes.has(command?.type)) {
          // Too fast: dropped, like a frame a slow viewer misses.
          if (!allowInput()) return;
          return await subscription.input(command).catch((error) => {
            if (["NOT_HOLDER", "VIEW_ONLY"].includes(error.code))
              send({ type: "error", code: error.code });
          });
        }
        if (command?.type === "select") subscription.select(command.targetId);
        else if (command?.type === "follow") subscription.follow();
        else if (command?.type === "start") await subscription.start();
        else if (command?.type === "take")
          subscription.take({ move: command.move === true });
        else if (command?.type === "handBack") subscription.handBack();
        else ws.close(1008);
      } catch (error) {
        send({ type: "error", code: error.code, message: error.message, key: error.key });
      }
    });
    ws.on("close", () => {
      clearInterval(ping);
      cleanupLogin();
      unwatchDrivers?.();
      unwatchAccess?.();
      subscription.close();
    });
  });
  return wss;
}
