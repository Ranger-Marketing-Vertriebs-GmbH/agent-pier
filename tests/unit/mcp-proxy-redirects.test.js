import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { once } from "node:events";
import { mcpRoute } from "../../server/features/mcp-servers/mcp-proxy.js";
import { MAX_REDIRECTS } from "../../server/features/mcp-servers/upstream-request.js";

// Names resolve from this table only, so a request reaches a named host only when the
// proxy connects to the address it checked.
const hosts = {
  "mcp.test": "127.0.0.1",
  "public.test": "93.184.216.34",
  localhost: "127.0.0.1",
};
const lookup = async (host) => {
  if (!hosts[host]) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return [{ address: hosts[host], family: 4 }];
};

/** A loopback HTTP server that records what it is asked and answers with `handler`. */
async function upstream(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const request = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(request);
      handler(request, res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { seen, port: server.address().port };
}

/** The proxy route for one OAuth server at `url`, as the runtime proxy calls it. */
async function proxied(t, url, { transport = "http" } = {}) {
  const tokens = [];
  const warnings = [];
  const route = mcpRoute({
    servers: {
      definition: () => ({ id: "srv-1", name: "docs", url, transport, auth: "oauth" }),
    },
    oauth: {
      held: () => true,
      token: async (_server, { stale } = {}) => {
        tokens.push(stale ?? null);
        return `token-${tokens.length}`;
      },
    },
    authorize: () => true,
    warn: (message) => warnings.push(message),
    lookup,
  });
  const server = http.createServer((req, res) => {
    const { search } = new URL(req.url, "http://127.0.0.1");
    route(req, res, { scope: ["mcp", "srv-1", "agent-a"], rest: "srv-1", search });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/mcp/srv-1`;
  const call = (init = {}) =>
    fetch(base, {
      method: "POST",
      redirect: "manual",
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      ...init,
      headers: {
        authorization: "Bearer proxy-credential",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "session-1",
        "mcp-protocol-version": "2025-06-18",
        ...init.headers,
      },
    });
  return { call, tokens, warnings };
}

const ok = (_request, res) =>
  res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');

test("a redirect on the server's own origin is followed with body, method and token", async (t) => {
  const server = await upstream(t, (request, res) =>
    request.url === "/mcp"
      ? res.writeHead(307, { location: "/v2/mcp?x=1" }).end()
      : ok(request, res),
  );
  // Only the injected lookup knows the name: the proxy connects to what it checked.
  const { call } = await proxied(t, `http://mcp.test:${server.port}/mcp`);
  const response = await call();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(
    server.seen.map((r) => `${r.method} ${r.url}`),
    ["POST /mcp", "POST /v2/mcp?x=1"],
  );
  const [, followed] = server.seen;
  assert.equal(followed.body, '{"jsonrpc":"2.0","id":1,"method":"ping"}');
  assert.equal(followed.headers.authorization, "Bearer token-1");
  assert.equal(followed.headers["mcp-session-id"], "session-1");
  assert.equal(followed.headers["content-type"], "application/json");
  assert.equal(followed.headers.host, `mcp.test:${server.port}`);
});

test("a redirect to another origin is followed without the server's credentials", async (t) => {
  const other = await upstream(t, ok);
  const server = await upstream(t, (_request, res) =>
    res.writeHead(308, { location: `http://127.0.0.1:${other.port}/mcp` }).end(),
  );
  // A server entered with a loopback address may name any routable address.
  const { call, tokens } = await proxied(t, `http://127.0.0.1:${server.port}/mcp`);
  const response = await call();
  assert.equal(response.status, 200);
  assert.equal(other.seen.length, 1);
  const [followed] = other.seen;
  assert.equal(followed.method, "POST");
  assert.equal(followed.body, '{"jsonrpc":"2.0","id":1,"method":"ping"}');
  assert.equal(followed.headers.authorization, undefined);
  assert.equal(followed.headers.cookie, undefined);
  assert.equal(followed.headers["mcp-session-id"], undefined);
  assert.equal(followed.headers["mcp-protocol-version"], "2025-06-18");
  assert.equal(followed.headers["content-type"], "application/json");
  assert.deepEqual(tokens, [null]);
});

test("a 401 of another origin does not renew the server's token", async (t) => {
  const other = await upstream(t, (_request, res) => res.writeHead(401).end());
  const server = await upstream(t, (_request, res) =>
    res.writeHead(307, { location: `http://127.0.0.1:${other.port}/mcp` }).end(),
  );
  const { call, tokens } = await proxied(t, `http://127.0.0.1:${server.port}/mcp`);
  assert.equal((await call()).status, 401);
  assert.deepEqual(tokens, [null]);
  assert.equal(server.seen.length, 1);
});

test("a redirect to an address more internal than the server is refused", async (t) => {
  const inside = await upstream(t, ok);
  for (const location of [
    `http://127.0.0.1:${inside.port}/mcp`,
    `http://localhost:${inside.port}/mcp`,
    "http://169.254.169.254/latest",
    "http://public.test/mcp",
    "file:///etc/hosts",
  ]) {
    const server = await upstream(t, (_request, res) =>
      res.writeHead(307, { location }).end(),
    );
    // A named server counts as the private network at most, wherever it resolves.
    const { call, warnings } = await proxied(t, `http://mcp.test:${server.port}/mcp`);
    const response = await call();
    assert.equal(response.status, 502, location);
    assert.equal(response.headers.get("location"), null);
    assert.equal((await response.json()).error.code, "upstream_redirect_refused");
    assert.equal(server.seen.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /"docs"/);
    // The same refusal is reported once.
    await call();
    assert.equal(warnings.length, 1);
  }
  assert.deepEqual(inside.seen, []);
});

test("a chain of redirects ends at the hop limit", async (t) => {
  const server = await upstream(t, (request, res) => {
    const hop = Number(new URL(request.url, "http://x").searchParams.get("hop") || 0);
    res.writeHead(307, { location: `/mcp?hop=${hop + 1}` }).end();
  });
  const { call } = await proxied(t, `http://mcp.test:${server.port}/mcp`);
  const response = await call();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "upstream_redirect_refused");
  assert.equal(server.seen.length, MAX_REDIRECTS + 1);
});

test("303, and 301 or 302 after a POST, continue as a GET without the body", async (t) => {
  for (const status of [301, 302, 303]) {
    const server = await upstream(t, (request, res) =>
      request.url === "/mcp"
        ? res.writeHead(status, { location: "/next" }).end()
        : ok(request, res),
    );
    const { call } = await proxied(t, `http://mcp.test:${server.port}/mcp`);
    assert.equal((await call()).status, 200);
    const [, followed] = server.seen;
    assert.equal(`${followed.method} ${followed.url}`, "GET /next", String(status));
    assert.equal(followed.body, "");
    assert.equal(followed.headers["content-type"], undefined);
    assert.equal(followed.headers.authorization, "Bearer token-1");
  }
});

test("an event stream behind a redirect passes event by event", async (t) => {
  let finish;
  const server = await upstream(t, (request, res) => {
    if (request.url === "/mcp") return res.writeHead(307, { location: "/stream" }).end();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: message\ndata: one\n\n");
    finish = () => res.end("event: message\ndata: two\n\n");
  });
  const { call } = await proxied(t, `http://mcp.test:${server.port}/mcp`);
  const response = await call({ method: "GET", body: undefined });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body.getReader();
  const first = await reader.read();
  // The first event is here while the server still holds the stream open.
  assert.equal(Buffer.from(first.value).toString(), "event: message\ndata: one\n\n");
  finish();
  let rest = "";
  for (let part; !(part = await reader.read()).done;) rest += Buffer.from(part.value);
  assert.equal(rest, "event: message\ndata: two\n\n");
});

test("an answer the server compressed unasked reaches the runtime decoded", async (t) => {
  const server = await upstream(t, (request, res) => {
    assert.equal(request.headers["accept-encoding"], "identity");
    res.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
    });
    res.end(zlib.gzipSync('{"zipped":true}'));
  });
  const { call } = await proxied(t, `http://mcp.test:${server.port}/mcp`);
  const response = await call();
  assert.equal(response.headers.get("content-encoding"), null);
  assert.deepEqual(await response.json(), { zipped: true });
});

test("a stale token of the server itself is renewed once and the request replayed", async (t) => {
  const server = await upstream(t, (request, res) =>
    request.headers.authorization === "Bearer token-2"
      ? ok(request, res)
      : res.writeHead(401).end(),
  );
  const { call, tokens } = await proxied(t, `http://mcp.test:${server.port}/mcp`);
  const response = await call();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("www-authenticate"), null);
  assert.deepEqual(tokens, [null, "token-1"]);
  assert.equal(server.seen[1].body, '{"jsonrpc":"2.0","id":1,"method":"ping"}');
});
