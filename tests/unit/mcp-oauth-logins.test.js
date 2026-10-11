import test from "node:test";
import assert from "node:assert/strict";
import {
  nudgedIdleTtl,
  pendingLoginMs,
} from "../../server/features/mcp-servers/mcp-oauth-logins.js";
import { McpCliError } from "../../server/features/mcp-servers/openclaw-mcp-cli.js";
import {
  local,
  oauthFixture as setup,
  redirect,
  refusal,
} from "../helpers/mcp-oauth-fixture.js";

test("a login start refuses before the CLI when the browser cannot reach the redirect", async (t) => {
  const f = setup(t);
  await assert.rejects(
    f.oauth.start(f.docs.id, { requestOrigin: "http://192.168.1.20:4380" }),
    refusal("plain-http-remote", 409),
  );
  await assert.rejects(
    f.oauth.start(f.docs.id, { requestOrigin: "https://pier.example.ts.net" }),
    refusal("loopback-redirect", 409),
  );
  await assert.rejects(f.oauth.start(f.docs.id, {}), refusal("plain-http-remote", 409));
  // Not compiled at all, and header servers neither.
  const snapshot = f.runtime.mcp;
  f.runtime.mcp = null;
  await assert.rejects(
    f.oauth.start(f.docs.id, { requestOrigin: local }),
    refusal("not-compiled", 409),
  );
  f.runtime.mcp = snapshot;
  const plain = f.servers.create({
    name: "plain",
    transport: "http",
    url: "https://x.example/",
  });
  await assert.rejects(
    f.oauth.start(plain.id, { requestOrigin: local }),
    refusal("not-oauth", 409),
  );
  assert.deepEqual(f.cli.calls, []);
});

test("only a change still pending for this server refuses its login", async (t) => {
  const f = setup(t);
  const other = f.servers.create({
    name: "other",
    transport: "http",
    url: "https://other.example/",
    auth: "oauth",
  });
  f.servers.setBindings("agent", f.home.id, [f.docs.id, other.id]);
  f.compile();
  // A stored but unapplied change to `other` leaves `docs` usable.
  f.servers.update(other.id, { revision: 1, oauthScope: "read" });
  f.changes.pending = true;
  assert.ok((await f.oauth.start(f.docs.id, { requestOrigin: local })).authorizationUrl);
  await assert.rejects(
    f.oauth.start(other.id, { requestOrigin: local }),
    refusal("not-compiled", 409),
  );
  // So does a changed redirect the Gateway has not received yet.
  f.setRedirect("https://pier.example.ts.net/api/mcp-servers/oauth/callback");
  await assert.rejects(
    f.oauth.start(f.docs.id, { requestOrigin: local }),
    refusal("not-compiled", 409),
  );
  assert.equal(f.cli.calls.length, 1);
});

test("the callback state is single use, expires and must match a started login", async (t) => {
  const f = setup(t);
  const start = await f.oauth.start(f.docs.id, { requestOrigin: local });
  assert.equal(start.authorizationUrl, "https://as.example/authorize?state=state-1");
  for (const state of [undefined, "", "state-x", ["state-1"]])
    await assert.rejects(
      f.oauth.complete({ state, code: "c" }),
      refusal("state-invalid", 400),
    );
  assert.deepEqual(await f.oauth.complete({ state: "state-1", code: "c1" }), {
    serverId: f.docs.id,
    result: "connected",
  });
  await assert.rejects(
    f.oauth.complete({ state: "state-1", code: "c1" }),
    refusal("state-invalid", 400),
  );
  // Expired after ten minutes.
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  f.advance(pendingLoginMs);
  await assert.rejects(
    f.oauth.complete({ state: "state-2", code: "c2" }),
    refusal("state-invalid", 400),
  );
  const completed = f.cli.calls.filter(([method]) => method === "completeLogin");
  assert.deepEqual(completed, [["completeLogin", "docs", "c1"]]);
});

test("two racing callbacks with one state run --code once", async (t) => {
  const f = setup(t);
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  const results = await Promise.allSettled([
    f.oauth.complete({ state: "state-1", code: "a" }),
    f.oauth.complete({ state: "state-1", code: "b" }),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected"],
  );
  assert.equal(results[1].reason.code, "state-invalid");
  assert.deepEqual(
    f.cli.calls.filter(([method]) => method === "completeLogin"),
    [["completeLogin", "docs", "a"]],
  );
});

test("a second start replaces the first pending login", async (t) => {
  const f = setup(t);
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  await assert.rejects(
    f.oauth.complete({ state: "state-1", code: "c" }),
    refusal("state-invalid", 400),
  );
  assert.equal(
    (await f.oauth.complete({ state: "state-2", code: "c" })).result,
    "connected",
  );
});

test("provider errors and CLI failures complete with a stable reason", async (t) => {
  const f = setup(t, {
    completeLogin: new McpCliError("session-missing", "Missing session"),
  });
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  assert.deepEqual(await f.oauth.complete({ state: "state-1", error: "access_denied" }), {
    serverId: f.docs.id,
    result: "error",
    reason: "access_denied",
  });
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  assert.equal(
    (await f.oauth.complete({ state: "state-2", error: "<script>" })).reason,
    "provider-error",
  );
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  assert.equal(
    (await f.oauth.complete({ state: "state-3", code: "c" })).reason,
    "session-missing",
  );
  assert.deepEqual(f.nudges(), []);
});

test("a completed login resets OpenClaw's backoff with exactly one mcp patch", async (t) => {
  const f = setup(t);
  const signature = f.runtime.mcp.signature;
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  await f.oauth.complete({ state: "state-1", code: "c" });
  assert.deepEqual(
    f.nudges().map((p) => p.patch),
    [{ mcp: { sessionIdleTtlMs: 0 } }],
  );
  // The key is not part of the compiled signature: nothing re-applies afterwards.
  assert.equal(f.runtime.mcp.signature, signature);
  const patches = f.gateway.patches.length;
  assert.equal(await f.changes.apply(), false);
  assert.equal(f.gateway.patches.length, patches);
  assert.equal(f.gateway.config.mcp.sessionIdleTtlMs, 0);

  await f.oauth.start(f.docs.id, { requestOrigin: local });
  await f.oauth.complete({ state: "state-2", code: "c" });
  assert.deepEqual(
    f.nudges().map((p) => p.patch.mcp.sessionIdleTtlMs),
    [0, null],
  );
  assert.equal(f.gateway.config.mcp.sessionIdleTtlMs, undefined);
  assert.equal(nudgedIdleTtl(undefined), 0);
  assert.equal(nudgedIdleTtl(0), null);
  assert.equal(nudgedIdleTtl(600000), 599999);
  assert.equal(nudgedIdleTtl(599999), 600000);
  // A Gateway that is not ready needs none: its next start begins without backoff.
  f.runtime.client.ready = false;
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  await f.oauth.complete({ state: "state-3", code: "c" });
  assert.equal(f.nudges().length, 2);
});

test("a login that only refreshes connects without a URL and resets the backoff", async (t) => {
  const f = setup(t, { startLogin: { authorized: true } });
  assert.deepEqual(await f.oauth.start(f.docs.id, { requestOrigin: local }), {
    connected: true,
  });
  assert.equal(f.nudges().length, 1);
  assert.equal(f.servers.oauthMemory(f.docs.id).everConnected, true);
});

test("CLI failures at the start map to stable codes with catalog messages", async (t) => {
  const f = setup(t, {
    startLogin: new McpCliError("redirect-rejected", "OpenClaw MCP login failed"),
  });
  await assert.rejects(f.oauth.start(f.docs.id, { requestOrigin: local }), (error) => {
    assert.equal(error.code, "redirect-rejected");
    assert.equal(error.status, 502);
    assert.ok(error.message.includes(redirect));
    return true;
  });
});

test("a changed redirect logs out before the next login registers again", async (t) => {
  const f = setup(t);
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  assert.equal(f.servers.oauthMemory(f.docs.id).loginRedirect, redirect);
  const remote = "https://pier.example.ts.net/api/mcp-servers/oauth/callback";
  f.setRedirect(remote);
  f.compile();
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  assert.deepEqual(
    f.cli.calls.map(([method]) => method),
    ["startLogin", "logout", "startLogin"],
  );
  assert.equal(f.servers.oauthMemory(f.docs.id).loginRedirect, remote);
});

test("calls for one server run one after another", async (t) => {
  let release;
  const gate = new Promise((done) => (release = done));
  const order = [];
  const f = setup(t, {
    startLogin: async () => {
      order.push("start");
      await gate;
      order.push("started");
      return { authorizationUrl: "https://as.example/a?state=s", state: "s" };
    },
    logout: async () => order.push("logout"),
  });
  const started = f.oauth.start(f.docs.id, { requestOrigin: local });
  await new Promise((done) => setImmediate(done));
  const loggedOut = f.oauth.logout(f.docs.id);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(order, ["start"]);
  release();
  await Promise.all([started, loggedOut]);
  assert.deepEqual(order, ["start", "started", "logout"]);
});

test("the list carries each OAuth server's status from a briefly cached status call", async (t) => {
  const status = { docs: { state: "authorized", hasTokens: true, expiresAt: 42 } };
  const f = setup(t, { status: () => status });
  const list = () => f.oauth.decorate(f.changes.list());
  const [docs] = await list();
  assert.equal(docs.oauthStatus, "connected");
  assert.equal(docs.oauthExpiresAt, 42);
  await list();
  assert.equal(f.cli.calls.length, 1, "cached");
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  status.docs = { state: "pending-authorization" };
  assert.equal((await list())[0].oauthStatus, "login-pending");
  await f.oauth.complete({ state: "state-1", code: "c" });
  status.docs = { state: "unauthenticated" };
  // Once connected, an unauthenticated server needs a new login.
  assert.equal((await list())[0].oauthStatus, "login-required");
  // An explicit logout forgets that: the server reads "not connected" again.
  await f.oauth.logout(f.docs.id);
  assert.deepEqual(f.servers.oauthMemory(f.docs.id), {
    everConnected: false,
    loginRedirect: null,
  });
  assert.equal((await list())[0].oauthStatus, "not-connected");
  assert.equal(f.cli.calls.filter(([m]) => m === "status").length, 4);
  // Without a compiled Gateway (starting, or a failed start) nothing is asked and
  // nothing is known; a failing CLI reads "unknown" too.
  f.advance(60000);
  f.cli.calls.length = 0;
  f.runtime.mcp = null;
  assert.equal((await list())[0].oauthStatus, "unknown");
  assert.deepEqual(f.cli.calls, []);
  // A Gateway that compiled no OAuth server asks nothing either.
  f.runtime.mcp = { servers: [], serverSignatures: {} };
  assert.equal((await list())[0].oauthStatus, "not-connected");
  assert.deepEqual(f.cli.calls, []);
  const failing = setup(t, { status: new McpCliError("cli-timeout", "x") });
  assert.equal(
    (await failing.oauth.decorate(failing.changes.list()))[0].oauthStatus,
    "unknown",
  );
});
