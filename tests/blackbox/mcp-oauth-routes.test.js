import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { createMcpCli } from "../../server/features/mcp-servers/openclaw-mcp-cli.js";

const fakeEntry = fileURLToPath(
  new URL("../fixtures/fake-openclaw-mcp.mjs", import.meta.url),
);
const remoteHost = "agentpier.example";
const owner = "owner@example.test";
const redirect = `https://${remoteHost}/api/mcp-servers/oauth/callback`;
// The provider's redirect back: a top-level navigation from another site.
const navigation = {
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};

/** A raw request, so Host and Tailscale headers reach AgentPier as a proxy sends them. */
function raw(base, endpoint, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + endpoint, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function setup(t) {
  const f = await applicationFixture(t, {
    ...enabledAssistants,
    remoteUrl: `https://${remoteHost}`,
    ownerLogin: owner,
  });
  const log = path.join(f.root, "cli.log");
  const env = {
    PATH: process.env.PATH,
    HOME: f.home,
    FAKE_OPENCLAW_LOG: log,
    FAKE_OPENCLAW_STATE: "11111111-1111-4111-8111-111111111111",
  };
  const oauth = f.application.assistantMcpOAuth;
  oauth.cli = createMcpCli({
    runtime: { nodePath: process.execPath, entryPath: fakeEntry, cwd: f.root },
    environment: () => env,
  });
  const created = await f.request("/api/mcp-servers", {
    method: "POST",
    body: {
      name: "docs",
      transport: "http",
      url: "https://mcp.example.com/v1",
      auth: "oauth",
    },
  });
  assert.equal(created.status, 201);
  const server = await created.json();
  // The running Gateway compiled the server (the fixture starts no Gateway).
  const compiled = (name) => {
    f.application.assistantRuntime.mcp = { servers: [name], redirectUrl: redirect };
    f.application.assistantMcpChanges.pending = false;
  };
  compiled("docs");
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const start = (state, origin = f.url) => {
    env.FAKE_OPENCLAW_STATE = state;
    return f.request(`/api/mcp-servers/${server.id}/oauth/login`, {
      method: "POST",
      origin,
    });
  };
  const local = (query, headers = navigation) =>
    raw(f.url, `/api/mcp-servers/oauth/callback?${new URLSearchParams(query)}`, headers);
  const remote = (query) =>
    local(query, {
      ...navigation,
      host: remoteHost,
      "tailscale-user-login": owner,
    });
  return { f, server, calls, start, local, remote, compiled };
}

const codes = (calls) => calls.filter((args) => args.some((a) => a.startsWith("--code")));

test("an OAuth login completes through the callback by its state alone", async (t) => {
  const { f, server, calls, start, local, remote } = await setup(t);
  const stateA = "aaaaaaaa-1111-4111-8111-111111111111";
  const stateB = "bbbbbbbb-1111-4111-8111-111111111111";

  // Starting needs the owner session.
  const anonymous = await fetch(`${f.url}/api/mcp-servers/${server.id}/oauth/login`, {
    method: "POST",
    headers: { origin: f.url },
  });
  assert.equal(anonymous.status, 401);
  const started = await start(stateA);
  assert.equal(started.status, 200);
  const body = await started.json();
  assert.equal(body.status, "authorize");
  assert.equal(new URL(body.authorizationUrl).searchParams.get("state"), stateA);
  assert.deepEqual(calls(), [["login", "docs"]]);

  // Wrong or missing state: 400 without a session and without running --code.
  for (const query of [{ state: "wrong", code: "c" }, { code: "c" }, {}]) {
    const refused = await local(query);
    assert.equal(refused.status, 400);
    assert.equal(JSON.parse(refused.body).code, "state-invalid");
  }
  assert.deepEqual(codes(calls()), []);

  // The provider's redirect on the HTTPS remote host, without a session cookie.
  const done = await remote({ code: "code-1", state: stateA });
  assert.equal(done.status, 303);
  assert.equal(
    done.headers.location,
    `/settings/mcp?oauth=connected&server=${server.id}`,
  );
  assert.ok(!done.body.includes("code-1"));
  assert.deepEqual(codes(calls()), [["login", "docs", "--code=code-1"]]);
  // Single use.
  assert.equal((await remote({ code: "code-1", state: stateA })).status, 400);

  // A second start replaces the first; the callback also works on 127.0.0.1.
  await start(stateA);
  await start(stateB);
  assert.equal((await local({ code: "code-2", state: stateA })).status, 400);
  const second = await local({ code: "code-3", state: stateB });
  assert.equal(second.status, 303);
  assert.match(second.headers.location, /oauth=connected/);
  assert.deepEqual(
    codes(calls()).map((args) => args[2]),
    ["--code=code-1", "--code=code-3"],
  );

  // A provider error comes back as a stable reason only.
  await start(stateA);
  const denied = await local({ error: "access_denied", state: stateA, x: "<b>" });
  assert.equal(
    denied.headers.location,
    `/settings/mcp?oauth=error&server=${server.id}&reason=access_denied`,
  );
  // A cross-site fetch (not a navigation) never reaches the callback.
  await start(stateB);
  const fetched = await local(
    { code: "c", state: stateB },
    {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    },
  );
  assert.equal(fetched.status, 403);
  assert.equal(codes(calls()).length, 2);
});

test("the list carries the status; logout and lifecycle changes log out first", async (t) => {
  const { f, server, calls, start, compiled } = await setup(t);
  const list = async () => (await f.request("/api/mcp-servers")).json();
  const statusCalls = () => calls().filter(([command]) => command === "status").length;
  const [docs] = await list();
  assert.equal(docs.oauthStatus, "connected");
  assert.equal(docs.oauthExpiresAt, 1791234567890);
  await list();
  assert.equal(statusCalls(), 1, "cached");

  const loggedOut = await f.request(`/api/mcp-servers/${server.id}/oauth/logout`, {
    method: "POST",
  });
  assert.equal(loggedOut.status, 204);
  assert.deepEqual(calls().at(-1), ["logout", "docs"]);
  await list();
  assert.equal(statusCalls(), 2, "invalidated by the logout");

  // Plain-HTTP network origins never start a login (the security layer already
  // refuses a foreign origin; the service refuses a plain network one).
  const before = calls().length;
  const foreign = await start("x", "http://192.168.1.20:4380");
  assert.equal(foreign.status, 403);
  assert.equal(calls().length, before);

  // Rename: logout under the old name before the store changes.
  const renamed = await f.request(`/api/mcp-servers/${server.id}`, {
    method: "PUT",
    body: { revision: 1, name: "renamed" },
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(calls().at(-1), ["logout", "docs"]);
  compiled("renamed");
  // Switch to headers: logout under the current name.
  const switched = await f.request(`/api/mcp-servers/${server.id}`, {
    method: "PUT",
    body: { revision: 2, auth: "headers", headers: { Authorization: "Bearer t" } },
  });
  assert.equal(switched.status, 200);
  assert.deepEqual(calls().at(-1), ["logout", "renamed"]);
  const logouts = calls().filter(([command]) => command === "logout").length;
  // A header server has no login to remove when deleted.
  assert.equal(
    (await f.request(`/api/mcp-servers/${server.id}`, { method: "DELETE" })).status,
    200,
  );
  assert.equal(calls().filter(([command]) => command === "logout").length, logouts);
});

test("deleting an OAuth server logs it out", async (t) => {
  const { f, server, calls } = await setup(t);
  const removed = await f.request(`/api/mcp-servers/${server.id}`, { method: "DELETE" });
  assert.ok([200, 204].includes(removed.status));
  assert.deepEqual(calls(), [["logout", "docs"]]);
});
