import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Operations } from "../../server/features/operations/operations.js";
import { readJson, atomic } from "../../server/features/operations/files.js";

async function fixture(t, { spawnFails = false } = {}) {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ap-activate-")),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, "data"),
    installRoot = path.join(temp, "install");
  await fs.mkdir(dataDir);
  await fs.mkdir(path.join(installRoot, "releases/1.0.0"), { recursive: true });
  await fs.writeFile(
    path.join(installRoot, "releases/1.0.0/release.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  await fs.symlink("releases/1.0.0", path.join(installRoot, "current"));
  const requests = [];
  const operations = new Operations({
    config: { dataDir },
    withSnapshotBarrier: (fn) => fn(),
    releaseOptions: {
      installRoot,
      processes: () => "",
      spawnImpl: (_command, args) => {
        requests.push(readJson(args[1]));
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() =>
          child.emit(spawnFails ? "error" : "spawn", new Error("spawn")),
        );
        return child;
      },
    },
  });
  t.after(() => operations.close());
  atomic(path.join(dataDir, "operations/releases/staged-one.json"), {
    id: "staged-one",
    version: "1.1.0",
  });
  return { operations, dataDir, requests };
}

test("activate with reloadSessions writes the marker after the helper spawned and keeps the flag out of the request", async (t) => {
  const { operations, dataDir, requests } = await fixture(t);
  const job = operations.activate({ stagedId: "staged-one", reloadSessions: true });
  await operations.jobs.close();
  const marker = readJson(path.join(dataDir, "operations/post-activation-reload.json"));
  assert.equal(marker.to, "1.1.0");
  assert.equal(marker.jobId, job.id);
  assert.ok(Date.parse(marker.requestedAt) > 0);
  assert.equal(requests.length, 1);
  assert.equal("reloadSessions" in requests[0], false);
  assert.equal(requests[0].stagedId, "staged-one");
});

test("activate without the flag, with false, or as rollback writes no marker", async (t) => {
  const { operations, dataDir } = await fixture(t);
  operations.activate({ stagedId: "staged-one" });
  operations.activate({ stagedId: "staged-one", reloadSessions: false });
  operations.activate({ version: "1.0.0", reloadSessions: true });
  await operations.jobs.close();
  assert.equal(
    readJson(path.join(dataDir, "operations/post-activation-reload.json"), null),
    null,
  );
});

test("activate rejects non-boolean flags, failed helper spawns leave no marker, and migrations block release jobs", async (t) => {
  const { operations, dataDir } = await fixture(t, { spawnFails: true });
  assert.throws(
    () => operations.activate({ stagedId: "staged-one", reloadSessions: "yes" }),
    /Invalid/,
  );
  const job = operations.activate({ stagedId: "staged-one", reloadSessions: true });
  await operations.jobs.close();
  assert.equal(operations.jobs.get(job.id).status, "failed");
  assert.equal(
    readJson(path.join(dataDir, "operations/post-activation-reload.json"), null),
    null,
  );
});

test("a running migration blocks activation and cleanup", async (t) => {
  const { operations } = await fixture(t);
  let release;
  operations.jobs.start(
    "release-migrate",
    () => new Promise((resolve) => (release = resolve)),
  );
  assert.throws(
    () => operations.activate({ stagedId: "staged-one" }),
    /migration is running/,
  );
  assert.throws(
    () => operations.cleanupReleases({ versions: ["1.0.0"] }),
    /migration is running/,
  );
  await Promise.resolve();
  release({});
  await operations.jobs.close();
});
