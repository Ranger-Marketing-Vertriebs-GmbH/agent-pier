import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { artifactFixture } from "../helpers/artifacts.js";
test("restored metadata cannot redirect artifact reads outside its generation", async (t) => {
  const f = await artifactFixture(t);
  await fs.writeFile(path.join(f.workspace, "report.html"), "report");
  const row = await f.service.publish(
    f.context,
    { requestId: randomUUID(), title: "Report", sourcePath: "report.html" },
    async () => {},
  );
  const file = path.join(f.dataDir, "artifacts/index.json");
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  state.records[row.id].generation = "../../outside";
  await fs.writeFile(file, JSON.stringify(state));
  await assert.rejects(f.restart(), { code: "ARTIFACT_IO_ERROR" });
});
test("object prototype names are never treated as stored artifacts", async (t) => {
  const f = await artifactFixture(t);
  for (const id of ["constructor", "toString", "__proto__"])
    await assert.rejects(f.service.get(id), { status: 404 });
});

test("failed metadata durability preserves both sides of a committed replacement", async (t) => {
  const f = await artifactFixture(t);
  const source = path.join(f.workspace, "report.html");
  await fs.writeFile(source, "before");
  const input = { requestId: randomUUID(), title: "Report", sourcePath: "report.html" };
  const row = await f.service.publish(f.context, input, async () => {});
  await fs.writeFile(source, "after");
  const original = syncFs.fsyncSync;
  let calls = 0;
  const mock = t.mock.method(syncFs, "fsyncSync", (fd) => {
    if (++calls === 2) throw Object.assign(new Error("disk fault"), { code: "EIO" });
    return original(fd);
  });
  await assert.rejects(
    f.service.publish(
      f.context,
      { ...input, requestId: randomUUID(), artifactId: row.id },
      async () => {},
    ),
    { code: "ARTIFACT_IO_ERROR" },
  );
  mock.mock.restore();
  const open = fs.open;
  const failedSync = t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.service.store.root)
      handle.sync = async () => {
        throw Object.assign(new Error("disk fault"), { code: "EIO" });
      };
    return handle;
  });
  await assert.rejects(f.service.reconcile(), { code: "EIO" });
  assert.equal((await fs.readdir(f.service.store.generations)).length, 2);
  failedSync.mock.restore();
  await f.restart();
  assert.equal(
    Buffer.from((await f.service.snapshot(row.id)).files[0].base64, "base64").toString(),
    "after",
  );
  assert.equal((await fs.readdir(f.service.store.generations)).length, 1);
});

test("revocation during generation sync prevents the final commit", async (t) => {
  const f = await artifactFixture(t);
  await fs.writeFile(path.join(f.workspace, "report.html"), "private");
  let authorized = true;
  const sync = f.service.store.syncGeneration.bind(f.service.store);
  t.mock.method(f.service.store, "syncGeneration", async (folder) => {
    await sync(folder);
    authorized = false;
  });
  await assert.rejects(
    f.service.publish(
      f.context,
      { requestId: randomUUID(), title: "Report", sourcePath: "report.html" },
      async () => {
        if (!authorized) throw Object.assign(new Error("revoked"), { status: 403 });
      },
    ),
    { code: "ARTIFACT_ACCESS_DENIED" },
  );
  assert.equal((await f.service.list()).total, 0);
  assert.deepEqual(await fs.readdir(f.service.store.generations), []);
});
