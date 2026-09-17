import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sshManagementFixture } from "../helpers/ssh-management.js";

test("project keys are replayable and private material never enters MCP results", async (t) => {
  const f = await sshManagementFixture(t),
    one = await f.session("one");
  const input = { name: "Deploy", requestId: "generate" };
  const key = await one.call("ssh_generate_key", input);
  assert.equal(key.projectId, one.project.projectId);
  assert.match(key.publicKey, /^ssh-ed25519 /);
  assert.equal((await one.call("ssh_generate_key", input)).id, key.id);
  assert.equal(f.management.store.keyStore.list().length, 1);
  assert.equal(JSON.stringify(key).includes("PRIVATE KEY"), false);
  await assert.rejects(one.call("ssh_generate_key", { ...input, name: "Other" }), {
    code: "SSH_REQUEST_CONFLICT",
  });
  const two = await f.session("two");
  await assert.rejects(two.call("ssh_get_public_key", { keyId: key.id }), {
    code: "SSH_WRONG_PROJECT",
  });
});

test("source import copies once, leaves source intact and replays after source removal", async (t) => {
  const f = await sshManagementFixture(t),
    one = await f.session("one");
  const key = await one.call("ssh_generate_key", { name: "Existing", requestId: "key" });
  const source = path.join(f.home, "existing");
  const bytes = fs.readFileSync(
    path.join(f.dataDir, "ssh", "identities", key.id, "identity"),
  );
  fs.writeFileSync(source, bytes, { mode: 0o600 });
  const input = { name: "Imported", sourcePath: source, requestId: "import" };
  const imported = await one.call("ssh_import_key", input);
  assert.equal(imported.id, key.id);
  assert.equal(imported.reused, true);
  assert.deepEqual(fs.readFileSync(source), bytes);
  fs.unlinkSync(source);
  assert.equal((await one.call("ssh_import_key", input)).id, key.id);
  await f.management.ui("removeKey", { id: key.id });
  await assert.rejects(one.call("ssh_import_key", input), {
    code: "SSH_REQUEST_RESOURCE_GONE",
  });
});

test("parallel project mutations keep both records and revoked calls cannot write", async (t) => {
  const f = await sshManagementFixture(t),
    one = await f.session("one"),
    two = await f.session("two", one.record.cwd);
  const keys = await Promise.all([
    one.call("ssh_generate_key", { name: "One", requestId: "one" }),
    two.call("ssh_generate_key", { name: "Two", requestId: "two" }),
  ]);
  assert.equal(new Set(keys.map((key) => key.id)).size, 2);
  assert.equal((await one.call("ssh_list_keys", {})).total, 2);
  fs.rmSync(path.join(f.dataDir, "ssh", "capabilities", "one"), { recursive: true });
  await assert.rejects(
    one.call("ssh_generate_key", { name: "Denied", requestId: "denied" }),
  );
  assert.equal(f.management.store.keyStore.list().length, 2);
});
