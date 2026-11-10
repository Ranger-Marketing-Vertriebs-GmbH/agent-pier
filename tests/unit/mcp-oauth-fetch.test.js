import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  OAuthAddressRefused,
  oauthFetch,
} from "../../server/features/mcp-servers/oauth-fetch.js";
import { AgentPierMcpOAuth } from "../../server/features/mcp-servers/mcp-oauth-agentpier.js";

// Names resolve from this table only; an unknown name does not resolve.
const hosts = {
  "mcp.example": "93.184.216.34",
  "auth.example": "93.184.216.35",
  "mcp.lan": "192.168.1.5",
  "auth.lan": "10.0.0.7",
  "inside.example": "10.0.0.8",
  "self.example": "127.0.0.1",
  "meta.example": "169.254.169.254",
  "tailnet.example": "100.64.0.3",
  localhost: "127.0.0.1",
};
const lookup = async (host) => {
  if (!hosts[host]) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return [{ address: hosts[host], family: 4 }];
};

/** Which of `urls` a flow of the server at `serverUrl` may fetch. */
async function reached(serverUrl, urls) {
  const sent = [];
  const fetch = oauthFetch(serverUrl, {
    lookup,
    send: async (url, _init, addresses) => {
      sent.push([url.href, addresses.map((a) => a.address)]);
      return new Response("{}");
    },
  });
  const allowed = [];
  for (const url of urls) {
    try {
      await fetch(url);
      allowed.push(url);
    } catch (error) {
      assert.ok(error instanceof OAuthAddressRefused, `${url}: ${error}`);
      // A TypeError would read as "no metadata here" to the SDK's discovery.
      assert.ok(!(error instanceof TypeError));
    }
  }
  assert.deepEqual(
    sent.map(([url]) => url),
    allowed.map((url) => new URL(url).href),
  );
  return allowed;
}

const elsewhere = [
  "https://auth.example/token",
  "http://auth.example/token",
  "https://inside.example/token",
  "https://auth.lan/token",
  "http://10.0.0.7:8080/token",
  "https://tailnet.example/token",
  "https://meta.example/latest",
  "http://169.254.169.254/latest",
  "https://self.example/token",
  "http://127.0.0.1:4380/api/state",
  "http://[::1]:4380/api/state",
  "http://[::ffff:127.0.0.1]:4380/api/state",
  "http://localhost:4380/api/state",
  "http://0.0.0.0:4380/api/state",
  "file:///etc/hosts",
];

test("a public server's flow reaches its own origin and public https only", async () => {
  assert.deepEqual(
    await reached("https://mcp.example/mcp", [
      "https://mcp.example/.well-known/oauth-protected-resource/mcp",
      "https://mcp.example/token",
      ...elsewhere,
    ]),
    [
      "https://mcp.example/.well-known/oauth-protected-resource/mcp",
      "https://mcp.example/token",
      "https://auth.example/token",
    ],
  );
  // Another port or scheme of the server's host is another origin: the rule applies.
  assert.deepEqual(
    await reached("https://mcp.example/mcp", [
      "https://mcp.example:8443/token",
      "http://mcp.example/token",
    ]),
    ["https://mcp.example:8443/token"],
  );
});

test("a server in the private network also reaches private addresses, never this machine", async () => {
  assert.deepEqual(await reached("https://mcp.lan/mcp", elsewhere), [
    "https://auth.example/token",
    "https://inside.example/token",
    "https://auth.lan/token",
    "http://10.0.0.7:8080/token",
    "https://tailnet.example/token",
  ]);
  assert.deepEqual(
    await reached("http://192.168.1.5:9000/mcp", [
      "http://192.168.1.5:9001/token",
      "http://127.0.0.1:4380/api/state",
    ]),
    ["http://192.168.1.5:9001/token"],
  );
});

test("a name that resolves to this machine counts as the private network at most", async () => {
  const allowed = await reached("https://self.example/mcp", [
    "https://self.example/token",
    ...elsewhere,
  ]);
  assert.ok(allowed.includes("https://self.example/token"));
  assert.ok(allowed.includes("https://auth.lan/token"));
  for (const url of allowed.slice(1))
    assert.ok(!/127\.0\.0\.1|::1|localhost|169\.254|meta\./.test(url), url);
});

test("a server on this machine reaches every routable address", async () => {
  for (const server of ["http://127.0.0.1:9000/mcp", "http://localhost:9000/mcp"])
    assert.deepEqual(
      await reached(server, elsewhere),
      elsewhere.filter(
        (url) =>
          !["http://auth.example/token", "http://0.0.0.0:4380/api/state"].includes(url) &&
          !url.startsWith("file:"),
      ),
    );
});

test("an unresolvable host is a network failure, not a refusal", async () => {
  const fetch = oauthFetch("https://mcp.example/mcp", {
    lookup,
    send: async () => assert.fail("nothing is sent"),
  });
  await assert.rejects(fetch("https://unknown.example/token"), TypeError);
});

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

/** AgentPier's flow for a public server whose metadata names `endpoints`. */
function flow(t, endpoints) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-fetch-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const requests = [];
  const state = { authorizationServer: "https://mcp.example", ...endpoints };
  const fetch = async (url, init) => {
    const { href, pathname, origin } = new URL(url);
    requests.push(`${init?.method || "GET"} ${href}`);
    if (pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json({
        resource: "https://mcp.example/mcp",
        authorization_servers: [state.authorizationServer],
      });
    if (pathname.startsWith("/.well-known/oauth-authorization-server"))
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: state.tokenEndpoint || `${origin}/token`,
        registration_endpoint: state.registrationEndpoint || `${origin}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (pathname === "/register")
      return json({ ...JSON.parse(init.body), client_id: "client-1" }, 201);
    if (pathname === "/token")
      return json({
        access_token: `at-${requests.length}`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "rt-1",
      });
    return json({ error: "not_found" }, 404);
  };
  // The vault stamps tokens with the real clock.
  let now = Date.now();
  const oauth = new AgentPierMcpOAuth({ dataDir, fetch, lookup, now: () => now });
  const server = { id: "srv-1", name: "docs", url: "https://mcp.example/mcp" };
  return { oauth, server, requests, state, advance: (ms) => (now += ms) };
}
const redirectUrl = "http://127.0.0.1:4380/api/mcp-servers/oauth/callback";
const inside = (requests) =>
  requests.filter((line) => /inside\.example|127\.0\.0\.1|10\.0\.0\./.test(line));

test("a login fails when the metadata names an internal authorization server or endpoint", async (t) => {
  for (const endpoints of [
    { authorizationServer: "https://inside.example" },
    { registrationEndpoint: "http://127.0.0.1:4380/register" },
    { registrationEndpoint: "https://inside.example/register" },
  ]) {
    const { oauth, server, requests } = flow(t, endpoints);
    await assert.rejects(oauth.start(server, { redirectUrl }), (error) => {
      assert.equal(error.code, "oauth-failed");
      assert.equal(error.cause?.name, "OAuthAddressRefused");
      return true;
    });
    assert.deepEqual(inside(requests), []);
    assert.equal(oauth.status(server).oauthStatus, "not-connected");
  }
});

test("a renewal never follows the metadata to an internal address", async (t) => {
  const { oauth, server, requests, state, advance } = flow(t, {
    authorizationServer: "https://auth.example",
  });
  const started = await oauth.start(server, { redirectUrl });
  assert.equal(new URL(started.authorizationUrl).origin, "https://auth.example");
  await oauth.complete(oauth.take(started.state), server, "code-1");
  const first = await oauth.token(server);
  assert.ok(requests.includes("POST https://auth.example/register"));
  assert.ok(requests.includes("POST https://auth.example/token"));
  // The token is due and the metadata now names an internal authorization server:
  // the renewal fails and the login is kept.
  advance(3_600_000);
  state.authorizationServer = "https://inside.example";
  await assert.rejects(oauth.token(server), (error) => {
    assert.equal(error.code, "REFRESH_FAILED");
    assert.equal(error.cause?.name, "OAuthAddressRefused");
    return true;
  });
  assert.equal(oauth.status(server).oauthStatus, "connected");
  // With public metadata again the renewal works.
  state.authorizationServer = "https://auth.example";
  const renewed = await oauth.token(server);
  assert.notEqual(renewed, first);
  // An internal token endpoint is not asked either; like every renewal the token
  // endpoint does not answer, it ends in a new login.
  advance(3_600_000);
  state.tokenEndpoint = "http://10.0.0.7:8080/token";
  await assert.rejects(oauth.token(server), { code: "LOGIN_REQUIRED" });
  assert.equal(oauth.status(server).oauthStatus, "login-required");
  assert.deepEqual(inside(requests), []);
});

test("a request connects to the checked addresses and answers like fetch", async (t) => {
  const seen = [];
  const listener = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, body });
      if (req.url === "/moved") return res.writeHead(302, { location: "/token" }).end();
      if (req.url === "/big") return res.end(Buffer.alloc(1024 * 1024 + 1));
      if (req.url === "/gzip") {
        res.writeHead(200, { "content-encoding": "gzip" });
        return res.end(zlib.gzipSync('{"zipped":true}'));
      }
      res.writeHead(req.url === "/missing" ? 404 : 200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ type: req.headers["content-type"] || null, body }));
    });
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const { port } = listener.address();
  // Only the injected lookup knows this name: the socket uses the checked address.
  const origin = `http://pinned.example:${port}`;
  const fetch = oauthFetch(`${origin}/mcp`, {
    lookup: async (host) => {
      assert.equal(host, "pinned.example");
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  const posted = await fetch(new URL(`${origin}/token`), {
    method: "POST",
    headers: new Headers({ accept: "application/json" }),
    body: new URLSearchParams({ grant_type: "refresh_token" }),
  });
  assert.equal(posted.ok, true);
  assert.deepEqual(await posted.json(), {
    type: "application/x-www-form-urlencoded;charset=UTF-8",
    body: "grant_type=refresh_token",
  });
  assert.equal(seen[0].host, `pinned.example:${port}`);
  const missing = await fetch(`${origin}/missing`);
  assert.equal(missing.status, 404);
  assert.equal(missing.ok, false);
  // A redirect is handed back, not followed.
  const moved = await fetch(`${origin}/moved`, { redirect: "manual" });
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.get("location"), "/token");
  assert.equal(seen.filter((r) => r.url === "/token").length, 1);
  assert.deepEqual(await (await fetch(`${origin}/gzip`)).json(), { zipped: true });
  await assert.rejects(fetch(`${origin}/big`), TypeError);
});
