import test from "node:test";
import assert from "node:assert/strict";
import { sshManagementFixture } from "../helpers/ssh-management.js";

async function host(f) {
  const key = await f.management.ui("createKey", { name: "Agent key" });
  return f.management.ui("createHost", {
    name: "nas-01",
    host: "nas.invalid",
    port: 22,
    username: "deploy",
    keyId: key.id,
    hostKey: key.publicKey,
  });
}

test("removing a host revokes agent grants first, while the host still exists", async (t) => {
  const f = await sshManagementFixture(t);
  const created = await host(f);
  const seen = [];
  f.management.onAccessChanged = (id) =>
    seen.push([id, f.management.store.list().some((h) => h.id === id)]);
  await f.management.ui("removeHost", { id: created.id });
  assert.deepEqual(seen, [[created.id, true]]);
  assert.equal(f.management.store.list().length, 0);
});

test("a failing revocation keeps the host", async (t) => {
  const f = await sshManagementFixture(t);
  const created = await host(f);
  f.management.onAccessChanged = () => {
    throw Error("agents unavailable");
  };
  await assert.rejects(f.management.ui("removeHost", { id: created.id }));
  assert.equal(f.management.store.list().length, 1);
});
