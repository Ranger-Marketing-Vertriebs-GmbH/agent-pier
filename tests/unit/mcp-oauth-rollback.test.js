import test from "node:test";
import assert from "node:assert/strict";
import { local, oauthFixture as setup } from "../helpers/mcp-oauth-fixture.js";

const v1 = "https://mcp.example.com/v1";
const pairs = (list) => list.map(({ name, url }) => ({ name, url }));
function stopDrain(f) {
  clearTimeout(f.oauth.drainTimer);
  f.oauth.drainTimer = null;
}

test("a rollback logs out again what was logged out since its snapshot", async (t) => {
  const f = setup(t);
  const other = f.servers.create({
    name: "other",
    transport: "http",
    url: "https://other.example/",
    auth: "oauth",
  });
  // Logged out before the snapshot: the restored state never held that login.
  await f.oauth.logout(other.id);
  f.advance(1000);
  const snapshotAt = f.oauth.now();
  f.advance(1000);
  const { authorizationUrl } = await f.oauth.start(f.docs.id, { requestOrigin: local });
  const state = new URL(authorizationUrl).searchParams.get("state");
  await f.oauth.complete({ state, code: "c" });
  // Since the snapshot: an owner logout and a URL change that logs out the old URL.
  await f.oauth.logout(f.docs.id);
  await f.changes.update(f.docs.id, { revision: 1, url: "https://mcp.example.com/v2" });
  stopDrain(f);

  f.oauth.afterRollback(snapshotAt);
  assert.deepEqual(pairs(f.servers.deferredLogouts()), [{ name: "docs", url: v1 }]);
  // A server under that name and URL stays uncompiled until the logout went through.
  const docs = f.servers.definitions().find((d) => d.id === f.docs.id);
  assert.equal(f.oauth.held({ ...docs, url: v1 }), true);
  assert.notEqual(f.oauth.drainTimer, null, "drained at once");
  stopDrain(f);
  f.cli.calls.length = 0;
  assert.deepEqual(await f.oauth.drain(), { remaining: 0, freed: false });
  assert.deepEqual(f.logouts(), [["logout", "docs"]]);
  assert.deepEqual(f.servers.deferredLogouts(), []);
});

test("a rollback newer than every logout queues nothing; of unknown time, all", async (t) => {
  const f = setup(t);
  await f.oauth.logout(f.docs.id);
  f.oauth.afterRollback(f.oauth.now() + 1);
  assert.deepEqual(f.servers.deferredLogouts(), []);
  assert.equal(f.oauth.drainTimer ?? null, null);
  f.oauth.afterRollback(undefined);
  assert.deepEqual(pairs(f.servers.deferredLogouts()), [{ name: "docs", url: v1 }]);
  stopDrain(f);
});

test("the logout history keeps the latest time per name and URL, bounded", (t) => {
  const f = setup(t);
  const target = { name: "docs", url: v1, transport: "http" };
  f.servers.recordLogout(target, 10);
  f.servers.recordLogout(target, 20);
  assert.deepEqual(pairs(f.servers.logoutsSince(15)), [{ name: "docs", url: v1 }]);
  for (let n = 0; n < 510; n++)
    f.servers.recordLogout({ ...target, name: `s${n}` }, 100 + n);
  assert.equal(f.servers.logoutsSince(0).length, 500);
  assert.deepEqual(
    f.servers
      .logoutsSince(15)
      .map((e) => e.name)
      .includes("docs"),
    false,
  );
});
