import http from "node:http";
import https from "node:https";

/**
 * HTTP server whose handler writes the response itself (SSE, delays, hangs); with
 * `{ tls: { key, cert } }` an HTTPS server.
 */
export async function scriptedUpstream(t, script, { tls } = {}) {
  const seen = [];
  const open = new Set();
  const handler = async (request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    for await (const chunk of request) raw += chunk;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const entry = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
      remotePort: request.socket.remotePort,
      closed: false,
    };
    request.on("close", () => (entry.closed = true));
    response.on("close", () => (entry.closed = true));
    seen.push(entry);
    await script(entry, response, seen.length - 1);
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.on("connection", (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return {
    base: `${tls ? "https" : "http"}://127.0.0.1:${server.address().port}`,
    seen,
    openConnections: () => open.size,
  };
}

export const sse = (response, text) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(text);
};
export const json = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
