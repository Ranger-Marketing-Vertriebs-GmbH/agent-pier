import test from "node:test";
import assert from "node:assert/strict";
import { authorizeRequest, appDocumentPath } from "../../server/http/security.js";
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
    "/settings",
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
