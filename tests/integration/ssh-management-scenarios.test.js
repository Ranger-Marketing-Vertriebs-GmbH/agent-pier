import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sshManagementFixture } from "../helpers/ssh-management.js";
import { SshManagement } from "../../server/features/ssh/ssh-management.js";
import { sshManagementClient } from "../../server/features/ssh/ssh-management-client.js";

const generate = (session, requestId = "key") =>
  session.call("ssh_generate_key", { name: "Deployment", requestId });
const hostInput = (key, overrides = {}) => ({
  name: "Deployment host",
  host: "host.invalid",
  port: 22,
  username: "deploy",
  keyId: key.id,
  hostKey: key.publicKey,
  trustSource: { kind: "user" },
  requestId: "host",
  ...overrides,
});
function sourceCopy(f, key) {
  const source = path.join(f.home, "disposable-source");
  fs.copyFileSync(path.join(f.dataDir, "ssh", "identities", key.id, "identity"), source);
  return source;
}

test("project hosts appear in concurrent sessions while bootstrap grants convey no key ownership", async (t) => {
  const f = await sshManagementFixture(t);
  const owner = await f.session("owner"),
    peer = await f.session("peer", owner.record.cwd);
  const foreign = await f.session("foreign");
  const key = await generate(owner),
    otherKey = await generate(foreign);
  const bootstrap = await foreign.call("ssh_register_host", hostInput(otherKey));
  await f.management.grants.set(owner.record, [bootstrap.id]);
  assert.deepEqual(await f.management.grants.effective(peer.record), []);
  await assert.rejects(
    owner.call("ssh_register_host", hostInput(otherKey, { requestId: "foreign-key" })),
    { code: "SSH_WRONG_PROJECT" },
  );
  await assert.rejects(
    owner.call(
      "ssh_register_host",
      hostInput(key, {
        requestId: "bad-pin",
        trustSource: { kind: "existing", accessId: bootstrap.id },
      }),
    ),
    { code: "SSH_HOST_CONFLICT" },
  );
  const host = await owner.call(
    "ssh_register_host",
    hostInput(key, {
      hostKey: otherKey.publicKey,
      trustSource: { kind: "existing", accessId: bootstrap.id },
    }),
  );
  assert.deepEqual(await f.management.grants.effective(owner.record), [
    bootstrap.id,
    host.id,
  ]);
  assert.deepEqual(await f.management.grants.effective(peer.record), [host.id]);
  assert.deepEqual(await f.management.grants.effective(foreign.record), [bootstrap.id]);
  assert.equal((await owner.call("ssh_list_keys", {})).total, 1);
  await f.management.ui("removeHost", { id: host.id });
  assert.deepEqual(await f.management.grants.effective(peer.record), []);
  assert.deepEqual(await f.management.grants.effective(owner.record), [bootstrap.id]);
});

test("moving a project tombstones every deduplicated import receipt and updates inherited grants", async (t) => {
  const f = await sshManagementFixture(t);
  const origin = await f.session("origin"),
    target = await f.session("target");
  const key = await generate(origin);
  await generate(target);
  const sourcePath = sourceCopy(f, key);
  const imports = ["import-one", "import-two"].map((requestId) => ({
    name: "Copy",
    sourcePath,
    requestId,
  }));
  for (const input of imports)
    assert.equal((await origin.call("ssh_import_key", input)).id, key.id);
  const input = hostInput(key),
    host = await origin.call("ssh_register_host", input);
  await f.management.ui("reassign", {
    fromProjectId: origin.project.projectId,
    toProjectId: target.project.projectId,
  });
  fs.unlinkSync(sourcePath);
  assert.deepEqual(await f.management.grants.effective(origin.record), []);
  assert.deepEqual(await f.management.grants.effective(target.record), [host.id]);
  for (const request of imports)
    await assert.rejects(origin.call("ssh_import_key", request), {
      code: "SSH_REQUEST_RESOURCE_GONE",
    });
  await assert.rejects(generate(origin), { code: "SSH_REQUEST_RESOURCE_GONE" });
  await assert.rejects(origin.call("ssh_register_host", input), {
    code: "SSH_REQUEST_RESOURCE_GONE",
  });
  assert.equal((await target.call("ssh_get_public_key", { keyId: key.id })).id, key.id);
  await f.management.ui("removeHost", { id: host.id });
  await f.management.ui("removeKey", { id: key.id });
  await assert.rejects(origin.call("ssh_import_key", imports[0]), {
    code: "SSH_REQUEST_RESOURCE_GONE",
  });
  assert.equal(f.management.store.keyStore.list().length, 1);
});

test("reassignment into matching key or endpoint leaves both catalogs and grants unchanged", async (t) => {
  const f = await sshManagementFixture(t);
  const origin = await f.session("origin"),
    target = await f.session("target");
  const first = await generate(origin),
    second = await generate(target);
  const oneHost = await origin.call("ssh_register_host", hostInput(first));
  const twoHost = await target.call(
    "ssh_register_host",
    hostInput(second, { host: "HOST.INVALID" }),
  );
  const move = () =>
    f.management.ui("reassign", {
      fromProjectId: origin.project.projectId,
      toProjectId: target.project.projectId,
    });
  const before = structuredClone(f.management.catalog.read());
  await assert.rejects(move(), { code: "SSH_PROJECT_COLLISION" });
  assert.deepEqual(f.management.catalog.read(), before);
  assert.deepEqual(await f.management.grants.effective(origin.record), [oneHost.id]);
  assert.deepEqual(await f.management.grants.effective(target.record), [twoHost.id]);
  await f.management.ui("removeHost", { id: twoHost.id });
  const sourcePath = sourceCopy(f, first);
  const alias = sourcePath + "-hardlink";
  fs.linkSync(sourcePath, alias);
  await target.call("ssh_import_key", {
    name: "Duplicate public identity",
    sourcePath: alias,
    requestId: "same-key",
  });
  const beforeKeyCollision = structuredClone(f.management.catalog.read());
  await assert.rejects(move(), { code: "SSH_PROJECT_COLLISION" });
  assert.deepEqual(f.management.catalog.read(), beforeKeyCollision);
  assert.deepEqual(fs.readFileSync(alias), fs.readFileSync(sourcePath));
});

test("IPC rejects forged generations and reconnects with receipts intact after service restart", async (t) => {
  const f = await sshManagementFixture(t),
    session = await f.session("live");
  const client = sshManagementClient(f.dataDir, session.capability);
  const input = { name: "Durable key", requestId: "stable" };
  const key = await client("ssh_generate_key", input);
  for (const capability of [
    { ...session.capability, token: "0".repeat(64) },
    { ...session.capability, generation: "old-generation" },
    { ...session.capability, sessionId: "unknown" },
  ])
    await assert.rejects(sshManagementClient(f.dataDir, capability)("ssh_list_keys"));
  await f.management.close();
  await assert.rejects(client("ssh_list_keys"), { code: "SSH_UNAVAILABLE" });
  const restarted = new SshManagement({ dataDir: f.dataDir, home: f.home });
  try {
    await restarted.ready;
    assert.equal((await client("ssh_generate_key", input)).id, key.id);
    assert.equal((await client("ssh_list_keys")).total, 1);
    await restarted.ui("removeKey", { id: key.id });
    await assert.rejects(client("ssh_generate_key", input), {
      code: "SSH_REQUEST_RESOURCE_GONE",
    });
    assert.equal((await client("ssh_list_keys")).total, 0);
  } finally {
    await restarted.close();
  }
});

test("IPC import errors never reflect malformed private content or local source paths", async (t) => {
  const f = await sshManagementFixture(t),
    session = await f.session("importer");
  const client = sshManagementClient(f.dataDir, session.capability);
  const source = path.join(f.home, "sensitive-source-marker");
  const bytes =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-content-marker\n-----END OPENSSH PRIVATE KEY-----\n";
  fs.writeFileSync(source, bytes, { mode: 0o600 });
  await assert.rejects(
    client("ssh_import_key", {
      name: "Bad source",
      sourcePath: source,
      requestId: "malformed",
    }),
    (error) => {
      assert.equal(error.code, "SSH_KEY_UNSUPPORTED");
      assert.doesNotMatch(
        error.message,
        /secret-content-marker|sensitive-source-marker|PRIVATE KEY/,
      );
      return true;
    },
  );
  assert.equal(fs.readFileSync(source, "utf8"), bytes);
  assert.equal((await client("ssh_list_keys")).total, 0);
  fs.unlinkSync(source);
  await assert.rejects(
    client("ssh_import_key", {
      name: "Missing source",
      sourcePath: source,
      requestId: "missing",
    }),
    (error) => {
      assert.doesNotMatch(error.message, /sensitive-source-marker|ENOENT/);
      return true;
    },
  );
});
