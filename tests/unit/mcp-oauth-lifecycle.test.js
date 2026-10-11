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

test("deferred logouts drain at the next apply and before a login reuses the name and URL", async (t) => {
  let broken = true;
  const f = setup(t, {
    logout: () => {
      if (broken) throw new McpCliError("cli-timeout", "x");
    },
  });
  await f.changes.remove(f.docs.id);
  assert.equal(f.servers.deferredLogouts().length, 1);
  // The same name and URL again, bound and compiled.
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

  // A Gateway apply drains too (and so does a start, through the same call).
  broken = true;
  await f.changes.update(again.id, { revision: 1, name: "renamed" });
  assert.equal(f.servers.deferredLogouts().length, 1);
  broken = false;
  await f.changes.apply();
  assert.deepEqual(f.servers.deferredLogouts(), []);
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
