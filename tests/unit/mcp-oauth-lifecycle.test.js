import test from "node:test";
import assert from "node:assert/strict";
import { McpCliError } from "../../server/features/mcp-servers/openclaw-mcp-cli.js";
import { local, oauthFixture as setup, refusal } from "../helpers/mcp-oauth-fixture.js";

const v1 = "https://mcp.example.com/v1";

for (const [label, change] of [
  ["rename", { name: "renamed" }],
  ["URL change", { url: "https://mcp.example.com/v2" }],
  ["switch to headers", { auth: "headers", headers: { Authorization: "Bearer t" } }],
]) {
  test(`a ${label} logs out under the old name and URL before saving`, async (t) => {
    const seen = [];
    const f = setup(t, {
      logout: (name, { server }) => {
        seen.push({ name, url: server.url, stored: f.servers.get(f.docs.id).name });
      },
    });
    await f.oauth.start(f.docs.id, { requestOrigin: local });
    await f.oauth.complete({ state: "state-1", code: "c" });
    await f.oauth.start(f.docs.id, { requestOrigin: local });
    const { logoutDeferred } = await f.changes.update(f.docs.id, {
      revision: 1,
      ...change,
    });
    assert.equal(logoutDeferred, false);
    // The store still held the old definition when OpenClaw was asked.
    assert.deepEqual(seen, [{ name: "docs", url: v1, stored: "docs" }]);
    assert.deepEqual(f.servers.oauthMemory(f.docs.id), {
      everConnected: false,
      loginRedirect: null,
    });
    // The pending login of the old definition is gone.
    await assert.rejects(
      f.oauth.complete({ state: "state-2", code: "c" }),
      refusal("state-invalid", 400),
    );
  });
}

test("delete logs out; unrelated edits, conflicts and taken names do not", async (t) => {
  const f = setup(t);
  f.servers.create({ name: "Other", transport: "http", url: "https://o.example/" });
  await f.changes.update(f.docs.id, { revision: 1, oauthScope: "read" });
  await assert.rejects(f.changes.update(f.docs.id, { revision: 1, name: "x" }), {
    status: 409,
  });
  // A rename to a taken name (any case) fails before anything is logged out.
  await assert.rejects(f.changes.update(f.docs.id, { revision: 2, name: "other" }), {
    status: 409,
    message: /bereits vergeben/,
  });
  assert.deepEqual(f.cli.calls, []);
  // A server the Gateway does not compile is logged out all the same.
  f.runtime.mcp = null;
  await f.changes.update(f.docs.id, { revision: 2, name: "moved" });
  assert.deepEqual(f.logouts(), [["logout", "docs"]]);
  assert.deepEqual(await f.changes.remove(f.docs.id), {
    pending: true,
    logoutDeferred: false,
  });
  assert.deepEqual(f.logouts(), [
    ["logout", "docs"],
    ["logout", "moved"],
  ]);
});

for (const [label, prepare] of [
  ["an unavailable runtime", { logout: new McpCliError("runtime-unavailable", "x") }],
  ["a CLI timeout", { logout: new McpCliError("cli-timeout", "x") }],
  ["a failing CLI", { logout: new McpCliError("cli-failed", "x") }],
]) {
  test(`${label} never blocks an edit or delete; the logout is deferred`, async (t) => {
    const f = setup(t, prepare);
    f.runtime.mcp = null;
    const renamed = await f.changes.update(f.docs.id, { revision: 1, name: "renamed" });
    assert.equal(renamed.logoutDeferred, true);
    assert.equal(f.servers.get(f.docs.id).name, "renamed");
    const removed = await f.changes.remove(f.docs.id);
    assert.equal(removed.logoutDeferred, true);
    assert.deepEqual(
      f.servers.deferredLogouts().map(({ name, url }) => ({ name, url })),
      [
        { name: "docs", url: v1 },
        { name: "renamed", url: v1 },
      ],
    );
    assert.equal(f.warnings.length, 2);
    assert.ok(!f.warnings.join().includes("docs"));
  });
}

test("a server OpenClaw does not know has nothing to log out", async (t) => {
  const f = setup(t, { logout: new McpCliError("server-unknown", "No MCP server") });
  const { logoutDeferred } = await f.changes.update(f.docs.id, {
    revision: 1,
    name: "renamed",
  });
  assert.equal(logoutDeferred, false);
  assert.deepEqual(f.servers.deferredLogouts(), []);
});

test("deferred logouts drain in the background and before a login reuses the name and URL", async (t) => {
  let broken = true;
  const f = setup(t, {
    logout: () => {
      if (broken) throw new McpCliError("cli-failed", "x");
    },
  });
  await f.changes.remove(f.docs.id);
  assert.equal(f.servers.deferredLogouts().length, 1);
  // The same name and URL again, bound.
  const again = f.servers.create({
    name: "docs",
    transport: "http",
    url: v1,
    auth: "oauth",
  });
  f.servers.setBindings("agent", f.home.id, [again.id]);
  f.compile();
  // While the CLI still fails, no login may start under the old tokens.
  await assert.rejects(
    f.oauth.start(again.id, { requestOrigin: local }),
    refusal("logout-failed", 409),
  );
  assert.ok(!f.cli.calls.some(([method]) => method === "startLogin"));
  broken = false;
  await f.oauth.start(again.id, { requestOrigin: local });
  assert.deepEqual(
    f.cli.calls.slice(-2).map(([method, name]) => [method, name]),
    [
      ["logout", "docs"],
      ["startLogin", "docs"],
    ],
  );
  assert.deepEqual(f.servers.deferredLogouts(), []);

  // A rename that defers: the background drain clears it once the CLI works.
  broken = true;
  await f.changes.update(again.id, { revision: 1, name: "renamed" });
  assert.equal(f.servers.deferredLogouts().length, 1);
  broken = false;
  await f.oauth.backgroundDrain();
  assert.deepEqual(f.servers.deferredLogouts(), []);
});

test("a server with an undrained logout for its name and URL is not compiled", async (t) => {
  let broken = true;
  const f = setup(t, {
    logout: () => {
      if (broken) throw new McpCliError("cli-failed", "x");
    },
    status: () => ({ docs: { state: "authorized", hasTokens: true } }),
  });
  await f.changes.remove(f.docs.id);
  const again = f.servers.create({
    name: "docs",
    transport: "http",
    url: v1,
    auth: "oauth",
  });
  const other = f.servers.create({
    name: "other",
    transport: "http",
    url: "https://o.example/",
    auth: "oauth",
  });
  await f.service.update(f.home.id, { mcpServers: [again.id, other.id] }, 1);
  // Left out like an unbound server; the apply itself is complete.
  assert.deepEqual(f.runtime.mcp.servers, ["other"]);
  assert.deepEqual(Object.keys(f.gateway.config.mcp.servers), ["other"]);
  assert.equal(f.changes.pending, false);
  const listed = (await f.oauth.decorate(f.changes.list())).find(
    (s) => s.id === again.id,
  );
  assert.equal(listed.oauthStatus, "login-required");
  assert.equal(listed.oauthReason.code, "logout-pending");
  assert.equal(listed.oauthReason.messageKey, "mcpServers.oauthLogoutPending");
  // Once the background drain goes through, the freed server compiles again.
  broken = false;
  await f.oauth.backgroundDrain();
  assert.deepEqual(f.servers.deferredLogouts(), []);
  assert.deepEqual(f.runtime.mcp.servers, ["docs", "other"]);
  const after = (await f.oauth.decorate(f.changes.list())).find((s) => s.id === again.id);
  assert.equal(after.oauthReason, undefined);
});

test("an orphan logout with a hanging CLI neither keeps applies pending nor holds the lock", async (t) => {
  let release;
  const hang = new Promise((done) => (release = done));
  let hanging = false;
  const f = setup(t, {
    logout: async () => {
      if (!hanging) throw new McpCliError("cli-timeout", "x");
      await hang;
      throw new McpCliError("cli-timeout", "x");
    },
  });
  t.after(() => release());
  await f.changes.remove(f.docs.id); // an orphan: no server has that name and URL
  hanging = true;
  // Drive the background drain by hand instead of its timer.
  clearTimeout(f.oauth.drainTimer);
  f.oauth.drainTimer = null;
  const draining = f.oauth.backgroundDrain();
  const plain = f.servers.create({ name: "plain", transport: "http", url: "https://p/" });
  f.servers.setBindings("agent", f.home.id, [plain.id]);
  // Applies and other admitted operations do not wait for the hanging logout.
  const quick = await Promise.race([
    f.service.admit(() => f.changes.apply()).then(() => "applied"),
    new Promise((done) => setTimeout(() => done("waited"), 500)),
  ]);
  assert.equal(quick, "applied");
  assert.equal(f.changes.pending, false);
  release();
  await draining;
  assert.equal(f.servers.deferredLogouts().length, 1);
});

test("a drain stops at the first timeout instead of paying one per entry", async (t) => {
  const f = setup(t, { logout: new McpCliError("cli-timeout", "x") });
  f.servers.deferLogout({ name: "a", url: "https://a/", transport: "http" });
  f.servers.deferLogout({ name: "b", url: "https://b/", transport: "http" });
  f.servers.deferLogout({ name: "c", url: "https://c/", transport: "http" });
  // The bounded pass before a Gateway start compiles.
  await f.changes.drainLogouts();
  assert.equal(f.logouts().length, 1);
  assert.equal(f.servers.deferredLogouts().length, 3);
  // The rest is left to the background drain, which is scheduled.
  assert.ok(f.oauth.drainTimer);
});

test("a login start and a rename are serialized by the admission lock", async (t) => {
  const f = setup(t);
  // Start first: it registers under the old name, then the rename logs it out.
  const [started] = await Promise.all([
    f.oauth.start(f.docs.id, { requestOrigin: local }),
    f.changes.update(f.docs.id, { revision: 1, name: "renamed" }),
  ]);
  assert.ok(started.authorizationUrl);
  assert.deepEqual(
    f.cli.calls.map(([method, name]) => [method, name]),
    [
      ["startLogin", "docs"],
      ["logout", "docs"],
    ],
  );
  await assert.rejects(
    f.oauth.complete({ state: "state-1", code: "c" }),
    refusal("state-invalid", 400),
  );
  // Rename first: the start then sees the new name, which the apply compiled.
  const g = setup(t);
  await Promise.all([
    g.changes.update(g.docs.id, { revision: 1, name: "renamed" }),
    g.oauth.start(g.docs.id, { requestOrigin: local }),
  ]);
  assert.deepEqual(
    g.cli.calls.map(([method, name]) => [method, name]),
    [
      ["logout", "docs"],
      ["startLogin", "renamed"],
    ],
  );
});

test("an edit rejected for its headers or environment never logs out", async (t) => {
  const f = setup(t);
  for (const change of [
    { auth: "headers", headers: { "bad name": "x" } },
    { auth: "headers", headers: { Authorization: "a\nb" } },
    { env: { TOKEN: "x" } },
    { name: "renamed", headers: { Authorization: "Bearer t" } },
    {
      auth: "headers",
      headers: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`H${i}`, "v"])),
    },
  ])
    await assert.rejects(f.changes.update(f.docs.id, { revision: 1, ...change }), {
      status: 400,
    });
  assert.deepEqual(f.cli.calls, []);
  assert.equal(f.servers.get(f.docs.id).revision, 1);
});

test("a drain skips an entry a login cleared in the meantime", async (t) => {
  let release;
  const gate = new Promise((done) => (release = done));
  const f = setup(t, {
    logout: async (name) => {
      if (name === "aaa") await gate;
    },
  });
  // Two deferred logouts; the drain snapshot holds both, and waits on the first.
  f.servers.deferLogout({ name: "aaa", url: "https://a.example/", transport: "http" });
  f.servers.deferLogout({ name: "docs", url: v1, transport: "http" });
  f.compile();
  const draining = f.oauth.drain();
  // Meanwhile the owner logs in to docs: its entry is cleared first, then a login.
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  await f.oauth.complete({ state: "state-1", code: "c" });
  release();
  await draining;
  const docsLogouts = f.logouts().filter(([, name]) => name === "docs");
  assert.equal(docsLogouts.length, 1, "only the login start's own clearing");
  // Nothing logged out after the fresh login completed.
  assert.equal(f.cli.calls.at(-1)[0], "completeLogin");
  assert.equal(f.servers.oauthMemory(f.docs.id).everConnected, true);
});

test("a rename queued behind --code leaves the server not ever connected", async (t) => {
  let release;
  const gate = new Promise((done) => (release = done));
  const f = setup(t, { completeLogin: () => gate });
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  const completing = f.oauth.complete({ state: "state-1", code: "c" });
  await new Promise((done) => setImmediate(done));
  const renaming = f.changes.update(f.docs.id, { revision: 1, name: "renamed" });
  await new Promise((done) => setImmediate(done));
  release();
  await Promise.all([completing, renaming]);
  assert.equal(f.servers.get(f.docs.id).name, "renamed");
  assert.equal(f.servers.oauthMemory(f.docs.id).everConnected, false);
});
