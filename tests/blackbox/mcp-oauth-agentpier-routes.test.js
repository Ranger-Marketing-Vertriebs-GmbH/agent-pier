import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { approve, oauthMcpServer } from "../helpers/mcp-oauth-test-server.js";

const navigation = {
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};
function navigate(target) {
  return new Promise((resolve, reject) => {
    const req = http.request(target, { headers: navigation }, (res) => {
      res.resume();
      res.on("end", () =>
        resolve({ status: res.statusCode, location: res.headers.location }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

// AgentPier's own MCP OAuth login through its routes: no OpenClaw CLI, no Gateway.
for (const transport of ["http", "sse"])
  test(`an OAuth login of a ${transport} server runs in AgentPier and ends at its callback`, async (t) => {
    const oauth = await oauthMcpServer();
    t.after(() => oauth.close());
    const f = await applicationFixture(t, enabledAssistants);
    const created = await f.request("/api/mcp-servers", {
      method: "POST",
      body: {
        name: "docs",
        transport,
        url: transport === "sse" ? oauth.sseUrl : oauth.url,
        auth: "oauth",
      },
    });
    assert.equal(created.status, 201);
    const server = await created.json();
    const started = await f.request(`/api/mcp-servers/${server.id}/oauth/login`, {
      method: "POST",
      origin: f.url,
    });
    assert.equal(started.status, 200);
    const body = await started.json();
    assert.equal(body.status, "authorize");
    const callback = await approve(body.authorizationUrl);
    assert.equal(callback.pathname, "/api/mcp-servers/oauth/callback");
    const back = await navigate(`${f.url}${callback.pathname}${callback.search}`);
    assert.equal(back.status, 303);
    assert.equal(back.location, `/accounts?oauth=connected&server=${server.id}`);
    // Only AgentPier registered a client, and the list names it as the holder.
    assert.deepEqual(
      [...oauth.clients.values()].map((c) => c.client_name),
      ["AgentPier"],
    );
    const list = await (await f.request("/api/mcp-servers")).json();
    const row = (list.servers || list).find((s) => s.id === server.id);
    assert.equal(row.oauthStatus, "connected");
    assert.equal(row.oauthHolder, "agentpier");
    // A used state completes nothing a second time.
    const replay = await navigate(`${f.url}${callback.pathname}${callback.search}`);
    assert.equal(replay.location, "/accounts?oauth=error&reason=state-invalid");
    const loggedOut = await f.request(`/api/mcp-servers/${server.id}/oauth/logout`, {
      method: "POST",
    });
    assert.equal(loggedOut.status, 204);
  });
