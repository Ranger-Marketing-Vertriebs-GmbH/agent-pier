import test from "node:test";
import assert from "node:assert/strict";
import { McpCliError } from "../../server/features/mcp-servers/openclaw-mcp-cli.js";
import { local, oauthFixture, redirect } from "../helpers/mcp-oauth-fixture.js";

const remote = "https://pier.example.ts.net/api/mcp-servers/oauth/callback";

/** A fixture whose backup revocations and CLI logouts land in one ordered log. */
function setup(t, script = {}, { revoke = () => {} } = {}) {
  const order = [];
  const f = oauthFixture(
    t,
    { logout: (name) => order.push(`logout:${name}`), ...script },
    {
      revokeBackups: () => {
        order.push("revoke");
        revoke();
      },
    },
  );
  return { ...f, order };
}

test("a logout destroys every backup key before OpenClaw forgets the login", async (t) => {
  const f = setup(t);
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  await f.oauth.complete({ state: "state-1", code: "c" });
  f.order.length = 0;
  await f.oauth.logout(f.docs.id);
  assert.deepEqual(f.order, ["revoke", "logout:docs"]);
});

test("a logout whose keys cannot be destroyed keeps the login", async (t) => {
  const f = setup(t, {}, { revoke: () => assert.fail("key folder unwritable") });
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  await f.oauth.complete({ state: "state-1", code: "c" });
  await assert.rejects(f.oauth.logout(f.docs.id), /key folder unwritable/);
  assert.deepEqual(f.logouts(), []);
  assert.equal(f.servers.oauthMemory(f.docs.id).everConnected, true);
});

test("a rename revokes backups only for a server AgentPier logged in", async (t) => {
  const f = setup(t);
  await f.changes.update(f.docs.id, { revision: 1, name: "fresh" });
  assert.deepEqual(f.order, ["logout:docs"]);
  f.order.length = 0;
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  await f.changes.update(f.docs.id, { revision: 2, name: "moved" });
  assert.deepEqual(f.order, ["revoke", "logout:fresh"]);
});

test("a deferred logout revokes backups again when it finally goes through", async (t) => {
  let broken = true;
  const f = setup(t, {
    logout: (name) => {
      if (broken) throw new McpCliError("cli-failed", "x");
      f.order.push(`logout:${name}`);
    },
  });
  clearTimeout(f.oauth.drainTimer);
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  await f.oauth.complete({ state: "state-1", code: "c" });
  const { logoutDeferred } = await f.changes.update(f.docs.id, {
    revision: 1,
    name: "renamed",
  });
  assert.equal(logoutDeferred, true);
  clearTimeout(f.oauth.drainTimer);
  f.oauth.drainTimer = null;
  f.order.length = 0;
  broken = false;
  assert.deepEqual(await f.oauth.drain(), { remaining: 0, freed: false });
  // A host backup taken while the logout waited may have sealed the old login.
  assert.deepEqual(f.order, ["revoke", "logout:docs"]);
});

test("after a rollback withheld a login, the server needs one under the new redirect", async (t) => {
  // AgentPier's store remembers a login under the old redirect; the rolled-back
  // OpenClaw state no longer holds it (its backup key was destroyed).
  const status = { docs: { state: "unauthenticated", hasClientInformation: false } };
  const f = setup(t, { status: () => status });
  f.servers.rememberOAuth(f.docs.id, { connected: true, loginRedirect: redirect });
  f.setRedirect(remote);
  f.compile();
  const [docs] = await f.oauth.decorate(f.changes.list());
  assert.equal(docs.oauthStatus, "login-required");
  f.order.length = 0;
  assert.ok((await f.oauth.start(f.docs.id, { requestOrigin: local })).authorizationUrl);
  // Logout first: a new client registration for the new redirect.
  assert.deepEqual(f.order, ["logout:docs"]);
  assert.deepEqual(
    f.cli.calls.map(([method]) => method).filter((m) => m !== "status"),
    ["logout", "startLogin"],
  );
  assert.equal(f.servers.oauthMemory(f.docs.id).loginRedirect, remote);
});

test("a server recreated after a host restore starts without a login", async (t) => {
  // Host backups carry neither the server nor its login: OpenClaw knows nothing.
  const f = setup(t, { status: () => ({ docs: { state: "unauthenticated" } }) });
  const [docs] = await f.oauth.decorate(f.changes.list());
  assert.equal(docs.oauthStatus, "not-connected");
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  assert.deepEqual(
    f.cli.calls.map(([method]) => method).filter((m) => m !== "status"),
    ["startLogin"],
  );
});
