import http from "node:http";

/**
 * A loopback registry: `routes[pathname] = (url) => ({ status, body, headers, delay })`.
 * Keys match the raw (still encoded) path, so `%2F` in a server name stays visible.
 */
export async function fakeRegistry(t, routes) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
    });
    const handler = routes[url.pathname] ?? routes["*"];
    const answer = handler ? await handler(url) : { status: 404, body: {} };
    if (answer.delay) return setTimeout(() => res.end(), answer.delay);
    res.writeHead(answer.status ?? 200, {
      "content-type": "application/json",
      ...(answer.headers ?? {}),
    });
    res.end(
      typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? {}),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}
