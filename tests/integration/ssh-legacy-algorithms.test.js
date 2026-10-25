import test from "node:test";
import assert from "node:assert/strict";
import { sshManagementFixture } from "../helpers/ssh-management.js";
import { SshTools } from "../../server/features/ssh/ssh-tools.js";

const legacyArgs = ["PubkeyAcceptedAlgorithms=+ssh-rsa", "HostKeyAlgorithms=+ssh-rsa"];
const argsOf = (store, id) => {
  const connection = store.connection(id);
  connection.cleanup();
  return connection.args;
};

test("only the owner switches legacy algorithms; agents see the flag and moves keep it", async (t) => {
  const f = await sshManagementFixture(t);
  const origin = await f.session("origin"),
    target = await f.session("target");
  const key = await origin.call("ssh_generate_key", { name: "Switch", requestId: "key" });
  const input = {
    name: "Old switch",
    host: "switch.invalid",
    port: 22,
    username: "admin",
    keyId: key.id,
    hostKey: key.publicKey,
    trustSource: { kind: "user" },
    requestId: "host",
  };
  await assert.rejects(
    origin.call("ssh_register_host", { ...input, legacyAlgorithms: true }),
    { code: "SSH_INVALID_ARGUMENT" },
  );
  const host = await origin.call("ssh_register_host", input);
  const before = f.management.store.revision(host.id);
  assert.equal(f.management.store.get(host.id).legacyAlgorithms, false);
  assert.ok(!argsOf(f.management.store, host.id).includes(legacyArgs[0]));

  const updated = await f.management.ui("updateHost", {
    id: host.id,
    body: { legacyAlgorithms: true },
  });
  assert.equal(updated.legacyAlgorithms, true);
  const row = f.management.catalog.read().hosts.find((item) => item.id === host.id);
  assert.equal(row.legacyAlgorithms, true);
  assert.notEqual(f.management.store.revision(host.id), before);
  for (const option of legacyArgs)
    assert.equal(
      argsOf(f.management.store, host.id).filter((arg) => arg === option).length,
      1,
    );
  const tools = new SshTools({
    dataDir: f.dataDir,
    capability: origin.capability,
    grants: f.management.grants,
    store: f.management.store,
  });
  t.after(() => tools.close());
  const listed = await tools.call("ssh_list_hosts", {});
  assert.equal(
    listed.hosts.find((item) => item.accessId === host.id).legacyAlgorithms,
    true,
  );

  // The target project becomes known once one of its sessions created a resource.
  await target.call("ssh_generate_key", { name: "Other", requestId: "other" });
  await f.management.ui("reassign", {
    fromProjectId: origin.project.projectId,
    toProjectId: target.project.projectId,
  });
  const moved = f.management.store.get(host.id);
  assert.equal(moved.projectId, target.project.projectId);
  assert.equal(moved.legacyAlgorithms, true);
  assert.ok(argsOf(f.management.store, host.id).includes(legacyArgs[1]));
});
