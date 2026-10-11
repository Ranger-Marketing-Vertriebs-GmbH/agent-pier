import test from "node:test";
import assert from "node:assert/strict";
import {
  mcpStartSnapshot,
  readMcpInputs,
} from "../../server/features/assistants/openclaw-config/mcp-servers.js";
import {
  McpOAuthLogins,
  nudgedIdleTtl,
  pendingLoginMs,
} from "../../server/features/mcp-servers/mcp-oauth-logins.js";
import { McpCliError } from "../../server/features/mcp-servers/openclaw-mcp-cli.js";
import { mcpApplyFixture } from "../helpers/mcp-apply-fixture.js";

const redirect = "http://127.0.0.1:4380/api/mcp-servers/oauth/callback";
const local = "http://127.0.0.1:4380";

/** A CLI stand-in that records every call in order and answers from `script`. */
function stubCli(script = {}) {
  const calls = [];
  let n = 0;
  const answer = async (method, args, fallback) => {
    calls.push([method, ...args]);
    const value = script[method];
    if (typeof value === "function") return value(...args);
    if (value instanceof Error) throw value;
    return value ?? fallback();
  };
  return {
    calls,
    startLogin: (name) =>
      answer("startLogin", [name], () => {
        const state = `state-${++n}`;
        return { authorizationUrl: `https://as.example/authorize?state=${state}`, state };
      }),
    completeLogin: (name, code) => answer("completeLogin", [name, code], () => undefined),
    logout: (name) => answer("logout", [name], () => undefined),
    status: () => answer("status", [], () => ({})),
  };
}

function setup(t, script, options = {}) {
  let clock = 1_000_000;
  const f = mcpApplyFixture(t, { redirectUrl: () => redirect });
  const cli = stubCli(script);
  const warnings = [];
  const oauth = new McpOAuthLogins({
    cli,
    servers: f.servers,
    runtime: f.runtime,
    admit: (operation) => f.service.admit(operation),
    isCurrent: () => !f.changes.pending,
    remoteUrl: () => options.remoteUrl ?? null,
    now: () => clock,
    warn: (text) => warnings.push(text),
  });
  f.changes.oauth = oauth;
  const home = f.agent("Home");
  const docs = f.servers.create({
    name: "docs",
    transport: "http",
    url: "https://mcp.example.com/v1",
    auth: "oauth",
  });
  f.servers.setBindings("agent", home.id, [docs.id]);
  // The running Gateway compiled the store as it is now.
  const compile = () => {
    f.runtime.mcp = mcpStartSnapshot(
      {
        profiles: f.store.listAssistants(),
        mcp: readMcpInputs(f.servers, { redirectUrl: redirect }),
      },
      () => {},
    );
  };
  compile();
  return {
    ...f,
    cli,
    oauth,
    docs,
    warnings,
    compile,
    advance: (ms) => (clock += ms),
    nudges: () =>
      f.gateway.patches.filter((p) => "sessionIdleTtlMs" in (p.patch.mcp || {})),
  };
}

const refusal = (code, status) => (error) => {
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  return true;
};

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
  // Not compiled (unbound, or a change still pending) and header servers neither.
  f.runtime.mcp = null;
  await assert.rejects(
    f.oauth.start(f.docs.id, { requestOrigin: local }),
    refusal("not-compiled", 409),
  );
  f.compile();
  f.changes.pending = true;
  await assert.rejects(
    f.oauth.start(f.docs.id, { requestOrigin: local }),
    refusal("not-compiled", 409),
  );
  f.changes.pending = false;
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
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  await f.oauth.complete({ state: "state-1", code: "c" });
  assert.deepEqual(
    f.nudges().map((p) => p.patch),
    [{ mcp: { sessionIdleTtlMs: 0 } }],
  );
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
  f.runtime.mcp.redirectUrl =
    "https://pier.example.ts.net/api/mcp-servers/oauth/callback";
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  assert.deepEqual(
    f.cli.calls.map(([method]) => method),
    ["startLogin", "logout", "startLogin"],
  );
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
  // A logout and a login each invalidate the cache.
  await f.oauth.logout(f.docs.id);
  status.docs = { state: "unauthenticated" };
  assert.equal((await list())[0].oauthStatus, "not-connected");
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  status.docs = { state: "pending-authorization" };
  assert.equal((await list())[0].oauthStatus, "login-pending");
  await f.oauth.complete({ state: "state-1", code: "c" });
  status.docs = { state: "unauthenticated" };
  // Once connected, an unauthenticated server needs a new login.
  assert.equal((await list())[0].oauthStatus, "login-required");
  assert.equal(f.cli.calls.filter(([m]) => m === "status").length, 4);
  // Without a compiled OAuth server nothing is asked; a failing CLI reads "unknown".
  f.advance(60000);
  f.cli.calls.length = 0;
  f.runtime.mcp = null;
  assert.equal((await list())[0].oauthStatus, "not-connected");
  assert.deepEqual(f.cli.calls, []);
  f.compile();
  status.docs = undefined;
  const failing = setup(t, { status: new McpCliError("cli-timeout", "x") });
  assert.equal(
    (await failing.oauth.decorate(failing.changes.list()))[0].oauthStatus,
    "unknown",
  );
});

for (const [label, change] of [
  ["rename", { name: "renamed" }],
  ["URL change", { url: "https://mcp.example.com/v2" }],
  ["switch to headers", { auth: "headers", headers: { Authorization: "Bearer t" } }],
]) {
  test(`a ${label} logs out under the old name before saving`, async (t) => {
    const f = setup(t, {
      logout: (name) => {
        // The store still holds the old definition at this point (a failed
        // assertion here would surface as a refused update).
        assert.equal(name, "docs");
        assert.equal(f.servers.get(f.docs.id).name, "docs");
        assert.equal(f.servers.get(f.docs.id).url, "https://mcp.example.com/v1");
      },
    });
    await f.oauth.start(f.docs.id, { requestOrigin: local });
    await f.changes.update(f.docs.id, { revision: 1, ...change });
    assert.deepEqual(f.cli.calls.at(-1), ["logout", "docs"]);
    // The pending login of the old definition is gone.
    await assert.rejects(
      f.oauth.complete({ state: "state-1", code: "c" }),
      refusal("state-invalid", 400),
    );
  });
}

test("delete logs out; unrelated edits, conflicts and uncompiled servers do not", async (t) => {
  const f = setup(t);
  await f.changes.update(f.docs.id, { revision: 1, oauthScope: "read" });
  await assert.rejects(f.changes.update(f.docs.id, { revision: 1, name: "x" }), {
    status: 409,
  });
  assert.deepEqual(f.cli.calls, []);
  f.runtime.mcp = null;
  await f.changes.update(f.docs.id, { revision: 2, name: "other" });
  assert.deepEqual(f.cli.calls, []);
  f.compile();
  await f.changes.remove(f.docs.id);
  assert.deepEqual(f.cli.calls, [["logout", "other"]]);
});

test("a failed logout blocks the change unless OpenClaw has nothing to log out", async (t) => {
  const f = setup(t, { logout: new McpCliError("cli-timeout", "timed out") });
  await assert.rejects(
    f.changes.update(f.docs.id, { revision: 1, name: "renamed" }),
    refusal("logout-failed", 409),
  );
  assert.equal(f.servers.get(f.docs.id).name, "docs");
  await assert.rejects(f.changes.remove(f.docs.id), refusal("logout-failed", 409));
  assert.equal(f.warnings.length, 2);
  assert.ok(!f.warnings.join().includes("docs"));

  const unknown = setup(t, {
    logout: new McpCliError("server-unknown", "No MCP server"),
  });
  await unknown.changes.update(unknown.docs.id, { revision: 1, name: "renamed" });
  assert.equal(unknown.servers.get(unknown.docs.id).name, "renamed");
});
