import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";
import { fixture } from "../helpers/file-publisher.js";
import { waitForFileJob } from "../helpers/file-explorer.js";
import { recoverPublications } from "../../server/features/files/file-recovery.js";

test("same-size restored-mtime change cannot satisfy a recorded content revision", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.target, "AAAA");
  const before = await fs.stat(f.target);
  const revision = await f.revision();
  const stage = await f.stage();
  await stage.handle.writeFile("BBBB");
  await fs.writeFile(f.target, "EVIL");
  await fs.utimes(f.target, before.atime, before.mtime);
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
    { code: "FILE_CONFLICT_CHANGED" },
  );
  assert.equal(await fs.readFile(f.target, "utf8"), "EVIL");
  assert.equal(await fs.readFile(stage.file, "utf8"), "BBBB");
  for (let replay = 0; replay < 2; replay++) {
    const [outcome] = await recoverPublications(f);
    assert.equal(outcome.phase, "interrupted");
    assert.equal(await fs.readFile(f.target, "utf8"), "EVIL");
    assert.equal(await fs.readFile(stage.file, "utf8"), "BBBB");
  }
});

for (const journalPhase of ["creating", "staging", "prepared", "exchanged", "swapped"])
  test(`restart reconciliation is finite after durable ${journalPhase}`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(f.target, "original");
    const revision = await f.revision();
    const put = f.store.putPublication.bind(f.store);
    let injected = false;
    f.store.putPublication = (record) => {
      if (injected && record.phase === "interrupted")
        throw new Error(`process stopped after durable ${journalPhase}`);
      const result = put(record);
      if (!injected && record.phase === journalPhase) {
        injected = true;
        throw new Error(`crash after durable ${journalPhase}`);
      }
      return result;
    };
    let stage;
    if (["creating", "staging"].includes(journalPhase))
      await assert.rejects(async () => {
        stage = await f.stage();
      });
    else {
      stage = await f.stage();
      await stage.handle.writeFile("replacement");
      await assert.rejects(
        f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
      );
    }
    assert.equal(injected, true);
    f.store.putPublication = put;
    const [first] = await recoverPublications(f);
    const [second] = await recoverPublications(f);
    assert.equal(first.id, f.store.listPublications()[0].id);
    if (["exchanged", "swapped"].includes(journalPhase)) {
      assert.equal(first.phase, "swapped");
      assert.equal(second.phase, "swapped");
      assert.equal(await fs.readFile(f.target, "utf8"), "replacement");
      assert.equal(await fs.readFile(stage.file, "utf8"), "original");
    } else {
      assert.equal(first.phase, "interrupted");
      assert.equal(second.phase, "interrupted");
      assert.equal(await fs.readFile(f.target, "utf8"), "original");
    }
  });

test("restart reconciliation accepts durable resolved creation exactly once", async (t) => {
  const f = await fixture(t);
  const put = f.store.putPublication.bind(f.store);
  let injected = false;
  f.store.putPublication = (record) => {
    if (injected && record.phase === "interrupted")
      throw new Error("process stopped after durable resolved");
    const result = put(record);
    if (!injected && record.phase === "resolved") {
      injected = true;
      throw new Error("crash after durable resolved");
    }
    return result;
  };
  const stage = await f.stage();
  await stage.handle.writeFile("created");
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: null }),
  );
  assert.equal(injected, true);
  f.store.putPublication = put;
  assert.equal(await fs.readFile(f.target, "utf8"), "created");
  assert.deepEqual(await recoverPublications(f), []);
  assert.deepEqual(await recoverPublications(f), []);
  assert.equal(await fs.readFile(f.target, "utf8"), "created");
});

test("application restart replays one immutable operation without duplicate effects", async (t) => {
  const f = await applicationFixture(t);
  const context = await (await f.request("/api/files/context")).json();
  const requestId = `${Date.now()}:11111111-1111-4111-8111-111111111111`;
  const operation = {
    requestId,
    kind: "create_file",
    sources: [],
    target: f.home,
    name: "restart-proof.txt",
    options: {},
  };
  const submit = () =>
    f.request("/api/files/operations", {
      method: "POST",
      headers: { "X-File-Scope": context.scopeId },
      body: operation,
    });
  const admitted = await submit();
  assert.equal(admitted.status, 202);
  const first = await admitted.json();
  assert.equal((await waitForFileJob(f, first.id)).status, "completed");
  await f.restart();
  const replayed = await submit();
  assert.equal(replayed.status, 202);
  const second = await replayed.json();
  assert.equal(second.id, first.id);
  assert.equal((await waitForFileJob(f, second.id)).status, "completed");
  assert.equal(await fs.readFile(`${f.home}/restart-proof.txt`, "utf8"), "");
  await delay(20);
  assert.deepEqual(await fs.readdir(f.home), ["restart-proof.txt"]);
});
