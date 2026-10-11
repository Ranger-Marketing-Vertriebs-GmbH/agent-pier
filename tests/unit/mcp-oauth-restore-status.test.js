import test from "node:test";
import assert from "node:assert/strict";
import { local, oauthFixture as setup, redirect } from "../helpers/mcp-oauth-fixture.js";

const remote = "https://pier.example.ts.net/api/mcp-servers/oauth/callback";
const methods = (f) =>
  f.cli.calls.map(([method]) => method).filter((m) => m !== "status");

test("after a rollback withheld a login, the server needs one under the new redirect", async (t) => {
  // AgentPier's store remembers a login under the old redirect; the rolled-back
  // OpenClaw state no longer holds it (its sealed rows were withheld).
  const status = { docs: { state: "unauthenticated", hasClientInformation: false } };
  const f = setup(t, { status: () => status });
  f.servers.rememberOAuth(f.docs.id, { connected: true, loginRedirect: redirect });
  f.setRedirect(remote);
  f.compile();
  const [docs] = await f.oauth.decorate(f.changes.list());
  assert.equal(docs.oauthStatus, "login-required");
  assert.ok((await f.oauth.start(f.docs.id, { requestOrigin: local })).authorizationUrl);
  // Logout first: a new client registration for the new redirect.
  assert.deepEqual(methods(f), ["logout", "startLogin"]);
  assert.equal(f.servers.oauthMemory(f.docs.id).loginRedirect, remote);
});

test("a server recreated after a host restore starts without a login", async (t) => {
  // Host backups carry neither the server nor its login: OpenClaw knows nothing.
  const f = setup(t, { status: () => ({ docs: { state: "unauthenticated" } }) });
  const [docs] = await f.oauth.decorate(f.changes.list());
  assert.equal(docs.oauthStatus, "not-connected");
  await f.oauth.start(f.docs.id, { requestOrigin: local });
  assert.deepEqual(methods(f), ["startLogin"]);
});
