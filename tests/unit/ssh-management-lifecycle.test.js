import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { sshManagementFixture } from "../helpers/ssh-management.js";
import { SshManagement } from "../../server/features/ssh/ssh-management.js";
import {
  sshManagementSocket,
  sshManagementClient,
} from "../../server/features/ssh/ssh-management-client.js";
import { readSshImport } from "../../server/features/ssh/ssh-import.js";

for (const origin of ["ui", "mcp"]) {
  test(`shutdown retains writer ownership until ${origin} preparation drains`, async (t) => {
    const f = await sshManagementFixture(t);
    const session = await f.session("owner");
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const prepare = f.management.store.keyStore.prepare.bind(f.management.store.keyStore);
    f.management.store.keyStore.prepare = async (...args) => {
      const prepared = await prepare(...args);
      entered.resolve();
      await release.promise;
      return prepared;
    };
    const operation =
      origin === "ui"
        ? f.management.ui("createKey", { name: "Held" })
        : session.call("ssh_generate_key", { name: "Held", requestId: "held" });
    const outcome = operation.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered.promise;
    let closed = false;
    const closing = f.management.close().then(() => {
      closed = true;
    });
    await setImmediate();
    const replacement = new SshManagement({ dataDir: f.dataDir });
    const replacementOutcome = await replacement.ready.then(
      () => "started",
      () => "rejected",
    );
    const closedEarly = closed;
    await replacement.close();
    release.resolve();
    const result = await outcome;
    await closing;
    assert.equal(closedEarly, false);
    assert.equal(replacementOutcome, "rejected");
    assert.ok(result.error);
    assert.equal(f.management.catalog.read().keys.length, 0);
  });
}

for (const aliasKind of ["data", "ssh"]) {
  test(`physical ${aliasKind} aliases share one SSH broker and client endpoint`, async (t) => {
    const f = await sshManagementFixture(t);
    const session = await f.session("owner");
    const alias = path.join(f.root, "alias");
    if (aliasKind === "data") fs.symlinkSync(f.dataDir, alias);
    else {
      fs.mkdirSync(alias);
      fs.symlinkSync(path.join(f.dataDir, "ssh"), path.join(alias, "ssh"));
    }
    const other = new SshManagement({ dataDir: alias });
    const started = await other.ready.then(
      () => true,
      () => false,
    );
    await other.close();
    assert.equal(started, false);
    assert.equal(sshManagementSocket(alias), sshManagementSocket(f.dataDir));
    assert.equal(
      (await sshManagementClient(alias, session.capability)("ssh_list_keys", {})).total,
      0,
    );
  });
}

test("import excludes a physical SSH root outside the data directory", async (t) => {
  const f = await sshManagementFixture(t);
  await f.management.close();
  const moved = path.join(f.root, "physical-ssh");
  fs.renameSync(path.join(f.dataDir, "ssh"), moved);
  fs.symlinkSync(moved, path.join(f.dataDir, "ssh"));
  const source = path.join(moved, "staging-private");
  fs.writeFileSync(source, "private fixture");
  assert.throws(
    () => readSshImport({ dataDir: f.dataDir, home: f.home, sourcePath: source }),
    { code: "SSH_IMPORT_SOURCE" },
  );
});

test("bootstrap grant revocation during final scope validation prevents host publication", async (t) => {
  const f = await sshManagementFixture(t);
  const owner = await f.session("owner"),
    foreign = await f.session("foreign");
  const key = await owner.call("ssh_generate_key", { name: "Owner", requestId: "key" });
  const other = await foreign.call("ssh_generate_key", {
    name: "Other",
    requestId: "key",
  });
  const input = {
    name: "Host",
    host: "host.invalid",
    port: 22,
    username: "deploy",
    hostKey: other.publicKey,
    requestId: "host",
  };
  const bootstrap = await foreign.call("ssh_register_host", {
    ...input,
    keyId: other.id,
    trustSource: { kind: "user" },
  });
  await f.management.grants.set(owner.record, [bootstrap.id]);
  const context = f.management.context.bind(f.management);
  let calls = 0;
  f.management.context = async (...args) => {
    const result = await context(...args);
    if (++calls === 4) f.management.grants.discard(owner.record.id);
    return result;
  };
  await assert.rejects(
    owner.call("ssh_register_host", {
      ...input,
      keyId: key.id,
      trustSource: { kind: "existing", accessId: bootstrap.id },
    }),
    { code: "SSH_WRONG_PROJECT" },
  );
  assert.equal(f.management.store.list().length, 1);
  assert.equal(
    f.management.catalog
      .read()
      .receipts.filter((row) => row.operation === "ssh_register_host").length,
    1,
  );
});

test("shutdown drains project registration waiting for the application barrier", async (t) => {
  const f = await sshManagementFixture(t);
  const session = await f.session("owner");
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  f.management.barrier = {
    run: async (callback) => {
      entered.resolve();
      await release.promise;
      return callback();
    },
  };
  const registration = f.management.registerProject(session.project);
  const outcome = registration.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await entered.promise;
  let closed = false;
  const closing = f.management.close().then(() => {
    closed = true;
  });
  await setImmediate();
  const closedEarly = closed;
  release.resolve();
  assert.equal((await outcome).error.code, "SSH_UNAVAILABLE");
  await closing;
  assert.equal(closedEarly, false);
  assert.deepEqual(f.management.catalog.read().projects, []);
  await assert.rejects(f.management.registerProject(session.project), {
    code: "SSH_BUSY",
  });
});
