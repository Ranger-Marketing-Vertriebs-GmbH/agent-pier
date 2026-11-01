import http from "node:http";
import net from "node:net";
import { downstreamHeaders, upstreamHeaders } from "./preview-headers.js";
import { pageLanguage, previewPage, refusalText } from "./preview-pages.js";
import { listenerPort } from "./preview-slots.js";
import { previewConfig } from "./preview-access.js";

const pageHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
// The upgrade response head of the dev server; anything longer is not a handshake.
const maxResponseHead = 64 * 1024;

function answer(res, status, body, headers = pageHeaders) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { ...headers, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const navigation = (req) =>
  ["GET", "HEAD"].includes(req.method) &&
  (req.headers["sec-fetch-mode"]
    ? req.headers["sec-fetch-mode"] === "navigate"
    : String(req.headers.accept || "").includes("text/html"));

/** Answers a refused request: a page for navigations, a plain status otherwise. */
function refuse(req, res, error) {
  const language = pageLanguage(req);
  const status = [401, 403].includes(error?.status) ? error.status : 500;
  if (status === 403)
    return answer(res, 403, previewPage("forbidden", { language }).html);
  if (status === 500 || !navigation(req))
    return answer(res, status, status === 401 ? refusalText(language) : "", {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
  // A cross-site navigation carries no SameSite=Strict cookie: navigate once more from
  // this origin, which sends it. Without a session after that, offer the sign-in.
  const kind = req.headers["sec-fetch-site"] === "cross-site" ? "bounce" : "signIn";
  answer(res, 401, previewPage(kind, { language, signInUrl: error.signInUrl }).html);
}

function refuseUpgrade(socket, status) {
  const reason = http.STATUS_CODES[status] || "Error";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

/** The upgrade response head without any Set-Cookie for AgentPier's session. */
function filterResponseHead(head) {
  return head
    .split("\r\n")
    .filter(
      (line) =>
        !/^set-cookie\s*:\s*agentpier_session\s*=/i.test(line) &&
        !/^clear-site-data\s*:/i.test(line),
    )
    .join("\r\n");
}

/**
 * One preview slot: a plain HTTP server that forwards the signed-in owner's requests and
 * WebSocket upgrades to the slot's dev server on loopback. Nothing reaches the dev
 * server before `gate` accepted the host branch and the owner session.
 */
export async function createPreviewListener({
  slot,
  host = "127.0.0.1",
  port = listenerPort(slot),
  gate,
  resolve,
  touch = () => {},
  watch,
  effective,
}) {
  // Without a watch, revoking the session would leave proxied sockets open.
  if (typeof watch !== "function")
    throw new TypeError("createPreviewListener needs watch(session, close)");
  const upgraded = new Set();
  // Connections with a forwarded response in flight (SSE, long polls, downloads).
  const forwarding = new Set();
  const previewOrigin = (req, branch) => {
    const remote = branch === "tailscale" && previewConfig(effective).remoteUrl;
    return `${remote ? new URL(remote).protocol : "http:"}//${req.headers.host}`;
  };

  async function request(req, res) {
    let access;
    try {
      access = await gate(req);
    } catch (error) {
      return refuse(req, res, error);
    }
    const found = await resolve(slot);
    if (!found) {
      const page = previewPage("idle", { language: pageLanguage(req) });
      return answer(res, page.status, page.html);
    }
    const { preview, address } = found;
    touch(preview);
    const options = {
      target: preview.target,
      previewOrigin: previewOrigin(req, access.branch),
    };
    const upstream = http.request({
      host: address,
      port: preview.target,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req, options),
    });
    const stop = watch(access.session, () => {
      upstream.destroy();
      req.socket.destroy();
    });
    forwarding.add(req.socket);
    res.once("close", () => {
      forwarding.delete(req.socket);
      stop();
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.on("response", (incoming) => {
      res.writeHead(
        incoming.statusCode,
        incoming.statusMessage,
        downstreamHeaders(incoming.headers, options),
      );
      // Server-sent events and chunked responses reach the browser as they arrive.
      res.flushHeaders();
      incoming.pipe(res);
      incoming.on("error", () => res.destroy());
    });
    upstream.on("error", () => {
      if (res.headersSent) return res.destroy();
      const page = previewPage("unreachable", {
        language: pageLanguage(req),
        label: preview.label,
        target: preview.target,
      });
      answer(res, page.status, page.html);
    });
    req.pipe(upstream);
  }

  async function upgrade(req, socket, head) {
    socket.on("error", () => {});
    let access;
    try {
      access = await gate(req);
    } catch (error) {
      return refuseUpgrade(
        socket,
        [401, 403].includes(error?.status) ? error.status : 500,
      );
    }
    const found = await resolve(slot);
    if (!found) return refuseUpgrade(socket, 404);
    const { preview, address } = found;
    touch(preview);
    const options = {
      target: preview.target,
      previewOrigin: previewOrigin(req, access.branch),
    };
    const headers = {
      ...upstreamHeaders(req, options),
      connection: "Upgrade",
      upgrade: req.headers.upgrade,
    };
    // The socket is piped raw after the handshake: no body framing in its head.
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    const upstream = net.connect({ host: address, port: preview.target });
    upgraded.add(socket);
    let stop = () => {};
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      stop();
      upgraded.delete(socket);
      socket.destroy();
      upstream.destroy();
    };
    stop = watch(access.session, cleanup);
    socket.on("close", cleanup);
    upstream.on("close", cleanup);
    let connected = false;
    upstream.on("error", () => {
      if (!connected) refuseUpgrade(socket, 502);
      cleanup();
    });
    upstream.on("connect", () => {
      connected = true;
      let lines = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(headers))
        for (const one of [].concat(value)) lines += `${key}: ${one}\r\n`;
      upstream.write(`${lines}\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream);
      // The handshake answer is read whole, so no agentpier_session cookie gets through.
      let buffered = Buffer.alloc(0);
      const read = (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        const end = buffered.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buffered.length > maxResponseHead) cleanup();
          return;
        }
        upstream.off("data", read);
        socket.write(
          filterResponseHead(buffered.subarray(0, end).toString("latin1")),
          "latin1",
        );
        socket.write(buffered.subarray(end));
        upstream.pipe(socket);
      };
      upstream.on("data", read);
    });
  }

  const server = http.createServer((req, res) => {
    request(req, res).catch(() => answer(res, 500, ""));
  });
  server.on("upgrade", (req, socket, head) => {
    upgrade(req, socket, head).catch(() => socket.destroy());
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      server.off("error", fail);
      done();
    });
  });
  return {
    server,
    // Ends every forwarded connection (the preview closed); the slot keeps listening.
    drop: () => {
      for (const socket of [...upgraded, ...forwarding]) socket.destroy();
    },
    close: () =>
      new Promise((done) => {
        for (const socket of upgraded) socket.destroy();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
