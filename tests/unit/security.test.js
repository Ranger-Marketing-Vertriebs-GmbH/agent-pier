import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeRequest,
  appDocumentPath,
  securityHeaders,
} from "../../server/http/security.js";
const config = {
  port: 4380,
  remoteUrl: "https://host.example.ts.net:8443",
  ownerLogin: "owner@example.com",
};
test("pipeline deep links are documents while action and API routes stay outside navigation exceptions", () => {
  for (const url of [
    "/pipelines",
    "/pipelines/runs/run-id",
    "/pipelines/definitions/new",
    "/pipelines/profiles/profile-id",
    "/pipelines/verification/project-id",
  ])
    assert.equal(appDocumentPath.test(url), true, url);
  for (const url of [
    "/api/pipeline-runs",
    "/pipelines/runs/run-id/cancel",
    "/pipelines/unknown",
    "/pipeline-profiles",
  ])
    assert.equal(appDocumentPath.test(url), false, url);
});
function request(headers = {}, method = "GET") {
  return {
    headers: { host: "127.0.0.1:4380", ...headers },
    method,
    socket: { remoteAddress: "127.0.0.1" },
  };
}
test("local same origin requests work but cross-origin writes are rejected", () => {
  assert.equal(authorizeRequest(request(), config), true);
  assert.equal(
    authorizeRequest(request({ origin: "http://127.0.0.1:4380" }, "POST"), config),
    true,
  );
  assert.throws(() =>
    authorizeRequest(request({ origin: "https://evil.example" }, "POST"), config),
  );
  assert.throws(() => authorizeRequest(request({}, "POST"), config));
  assert.throws(() =>
    authorizeRequest(request({ "sec-fetch-site": "cross-site" }), config),
  );
});
test("rejects DNS rebinding and unauthorized remote identities", () => {
  assert.throws(() => authorizeRequest(request({ host: "evil.example" }), config));
  assert.throws(() =>
    authorizeRequest(request({ host: "host.example.ts.net:8443" }), config),
  );
  assert.throws(() =>
    authorizeRequest(
      request({
        host: "host.example.ts.net:8443",
        "tailscale-user-login": "other@example.com",
      }),
      config,
    ),
  );
  assert.equal(
    authorizeRequest(
      request({
        host: "host.example.ts.net:8443",
        "tailscale-user-login": "owner@example.com",
      }),
      config,
    ),
    true,
  );
});
test("websocket requires exact origin and owner for remote connections", () => {
  assert.throws(() => authorizeRequest(request(), config, true));
  assert.equal(
    authorizeRequest(request({ origin: "http://127.0.0.1:4380" }), config, true),
    true,
  );
  assert.equal(
    authorizeRequest(
      request({
        host: "host.example.ts.net:8443",
        origin: "https://host.example.ts.net:8443",
        "tailscale-user-login": "owner@example.com",
      }),
      config,
      true,
    ),
    true,
  );
  assert.throws(() =>
    authorizeRequest(
      request({
        host: "host.example.ts.net:8443",
        origin: "http://host.example.ts.net:8443",
        "tailscale-user-login": "owner@example.com",
      }),
      config,
      true,
    ),
  );
});
test("a proxy cannot bypass Tailscale owner checks by spoofing the local Host", () => {
  for (const headers of [
    { "tailscale-user-login": "other@example.com" },
    { "x-forwarded-for": "100.1.2.3" },
    { "x-forwarded-host": "host.example.ts.net:8443" },
    { "x-forwarded-proto": "https" },
  ]) {
    assert.throws(() =>
      authorizeRequest(
        request({ ...headers, origin: "http://127.0.0.1:4380" }, "POST"),
        config,
      ),
    );
    assert.throws(() => authorizeRequest(request(headers), config));
  }
});
test("opening the app by a user-clicked external link is allowed without allowing cross-site API fetches", () => {
  const navigation = request({
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
  });
  navigation.url = "/";
  assert.equal(authorizeRequest(navigation, config), true);
  const remote = request({
    ...navigation.headers,
    host: "host.example.ts.net:8443",
    "tailscale-user-login": "owner@example.com",
  });
  remote.url = "/";
  assert.equal(authorizeRequest(remote, config), true);
  assert.throws(() =>
    authorizeRequest(
      request({
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      }),
      config,
    ),
  );
});
test("user-clicked deep links are allowed only for documents, never APIs or images", () => {
  const headers = {
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
  };
  for (const url of [
    "/accounts",
    "/repositories",
    "/projects",
    "/projects/example?tab=knowledge",
    "/settings",
    "/settings/github",
    "/agentbus",
    "/agentbus/messages/demo?page=2",
    "/plugins/local-codex",
    "/extensions/local-claude",
    "/sessions/example/reader",
    "/sessions/example/chat",
    "/sessions/example/terminal",
  ])
    assert.equal(authorizeRequest({ ...request(headers), url }, config), true, url);
  for (const url of [
    "/api/state",
    "/api/sessions/example/chat/images/file",
    "/assets/index.js",
  ])
    assert.throws(() => authorizeRequest({ ...request(headers), url }, config));
  assert.throws(() =>
    authorizeRequest(
      { ...request({ ...headers, "sec-fetch-dest": "iframe" }), url: "/accounts" },
      config,
    ),
  );
});

test("document navigation without activation metadata supports WebKit but never API or frame access", () => {
  const headers = {
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };
  for (const url of ["/", "/memory/project", "/sessions/demo/chat"]) {
    assert.equal(authorizeRequest({ ...request(headers), url }, config), true);
    assert.throws(() =>
      authorizeRequest(
        { ...request({ ...headers, "sec-fetch-dest": "iframe" }), url },
        config,
      ),
    );
    assert.throws(() => authorizeRequest({ ...request(headers, "POST"), url }, config));
  }
  for (const url of ["/api/state", "/api/sessions/demo/input", "/assets/app.js"])
    assert.throws(() => authorizeRequest({ ...request(headers), url }, config));
});

test("a navigation the service worker re-fetches, such as an OAuth return, opens the page", () => {
  const headers = {
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "empty",
  };
  const url = "/accounts?oauth=connected&server=4f1802c1-97bd-4615-83eb-002860bb0d94";
  assert.equal(authorizeRequest({ ...request(headers), url }, config), true);
  for (const blocked of [
    { ...headers, "sec-fetch-dest": "iframe" },
    { ...headers, "sec-fetch-mode": "cors" },
    { ...headers, "sec-fetch-mode": "no-cors" },
    { ...headers, "sec-fetch-mode": "same-origin" },
  ])
    assert.throws(() => authorizeRequest({ ...request(blocked), url }, config));
  for (const api of ["/api/state", "/assets/app.js"])
    assert.throws(() => authorizeRequest({ ...request(headers), url: api }, config));
  assert.throws(() => authorizeRequest({ ...request(headers, "POST"), url }, config));
});
const networkConfig = {
  ...config,
  network: { enabled: true, bind: "0.0.0.0", hosts: ["agentpier.home.arpa"] },
  networkHosts: new Set(["agentpier.home.arpa:4380", "192.168.1.20:4380"]),
};
const lan = (headers = {}, method = "GET", remoteAddress = "192.168.1.55") => ({
  headers: { host: "192.168.1.20:4380", ...headers },
  method,
  socket: { remoteAddress },
});
test("network branch accepts listed hosts from the LAN with matching origin", () => {
  assert.equal(authorizeRequest(lan(), networkConfig), true);
  assert.equal(
    authorizeRequest(lan({ origin: "http://192.168.1.20:4380" }, "POST"), networkConfig),
    true,
  );
  assert.equal(
    authorizeRequest(
      lan(
        { host: "agentpier.home.arpa:4380", origin: "http://agentpier.home.arpa:4380" },
        "POST",
      ),
      networkConfig,
    ),
    true,
  );
  assert.throws(
    () =>
      authorizeRequest(
        lan({ origin: "http://agentpier.home.arpa:4380" }, "POST"),
        networkConfig,
      ),
    { status: 403 },
  );
});
test("network branch ignores proxy headers but rejects Tailscale markers and unknown hosts", () => {
  assert.equal(
    authorizeRequest(
      lan({ "x-forwarded-for": "10.0.0.1", forwarded: "for=10.0.0.1" }),
      networkConfig,
    ),
    true,
  );
  assert.equal(authorizeRequest(lan({}, "GET", "127.0.0.1"), networkConfig), true);
  assert.throws(
    () => authorizeRequest(lan({ "tailscale-user-login": "x" }), networkConfig),
    {
      status: 403,
    },
  );
  assert.throws(
    () => authorizeRequest(lan({ host: "evil.example:4380" }), networkConfig),
    {
      status: 403,
    },
  );
  assert.throws(() => authorizeRequest(lan(), config), { status: 403 });
  assert.throws(
    () =>
      authorizeRequest(lan(), {
        ...networkConfig,
        network: { ...networkConfig.network, enabled: false },
      }),
    { status: 403 },
  );
});
test("local and Tailscale branches are unchanged by the network mode", () => {
  assert.equal(authorizeRequest(request(), networkConfig), true);
  assert.throws(
    () => authorizeRequest(request({ "x-forwarded-for": "1.1.1.1" }), networkConfig),
    {
      status: 403,
    },
  );
  assert.equal(
    authorizeRequest(
      request({
        host: "host.example.ts.net:8443",
        "tailscale-user-login": "owner@example.com",
      }),
      networkConfig,
    ),
    true,
  );
});

test("the provider's redirect to the MCP OAuth callback is a navigation on both hosts", () => {
  // A redirect from the provider carries no activation; WebKit may omit everything.
  const headers = {
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };
  const url = "/api/mcp-servers/oauth/callback?code=c&state=s";
  assert.equal(authorizeRequest({ ...request(headers), url }, config), true);
  const remote = {
    ...request({
      ...headers,
      host: "host.example.ts.net:8443",
      "tailscale-user-login": "owner@example.com",
    }),
    url,
  };
  assert.equal(authorizeRequest(remote, config), true);
  // Only a top-level GET document navigation, only that path, only the owner.
  const denied = [
    {
      ...request({ ...headers, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }),
      url,
    },
    { ...request({ ...headers, "sec-fetch-dest": "iframe" }), url },
    { ...request(headers, "POST"), url },
    { ...request(headers), url: "/api/mcp-servers/oauth/callbackx?state=s" },
    { ...request(headers), url: "/api/mcp-servers/x/oauth/login" },
    { ...remote, headers: { ...remote.headers, "tailscale-user-login": "other@x.com" } },
  ];
  for (const req of denied) assert.throws(() => authorizeRequest(req, config), req.url);
});

function policyFor(path) {
  const headers = {};
  securityHeaders(
    { path },
    { setHeader: (name, value) => (headers[name] = value) },
    () => {},
  );
  const policy = headers["Content-Security-Policy"];
  return Object.fromEntries(
    policy.split(";").map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

test("the app may show blob: images (the browser live view), artifacts may not", () => {
  assert.deepEqual(policyFor("/agents/home/browser")["img-src"], [
    "'self'",
    "data:",
    "blob:",
  ]);
  assert.deepEqual(policyFor("/artifacts/view/abc")["img-src"], ["'self'", "data:"]);
});
