import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { Restore } from "../../server/features/operations/restore.js";
import { RestoreUploads } from "../../server/features/operations/restore-upload.js";
import { Operations } from "../../server/features/operations/operations.js";
import {
  claim,
  claimable,
  currentOwner,
  procStart,
  ownerAlive,
  removeAbandonedWork,
} from "../../server/features/operations/work-claims.js";
import { writeArchive } from "../../server/features/operations/archive-v2.js";

const operations = path.resolve("server/features/operations");
function setup(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-claims-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  return { root, dataDir };
}
/** Runs `body` (module code using `dataDir` and `ops`) in a separate Node process. */
function inProcess(dataDir, body) {
  const script = `const ops = ${JSON.stringify(operations)};
const dataDir = ${JSON.stringify(dataDir)};
${body}`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}
async function archive(root) {
  const file = path.join(root, `${randomUUID()}.apbackup`);
  await writeArchive(file, {
    manifest: {
      createdAt: new Date().toISOString(),
      applicationVersion: "1",
      includeHistory: false,
      withCredentials: false,
      consistency: "per-component-snapshots; independent-native-captures",
      omissions: [],
      captures: [],
    },
    members: [{ path: "accounts.json", bytes: Buffer.from("[]") }],
  });
  return fs.readFileSync(file);
}

test("another process starting up or running the CLI never removes live work", async (t) => {
  const { root, dataDir } = setup(t);
  const restore = new Restore({ dataDir });
  const bytes = await archive(root);
  const { uploadId } = restore.uploads.begin(bytes.length);
  const half = Math.floor(bytes.length / 2);
  await restore.uploads.append(uploadId, 0, [bytes.subarray(0, half)], half);
  // A restore stage and an inspection folder this process works on.
  const stage = path.join(root, `.agentpier-restore-${randomUUID()}`);
  claim(dataDir, stage);
  fs.mkdirSync(stage);
  const inspection = path.join(restore.directory, `.inspect-${randomUUID()}`);
  claim(dataDir, inspection);
  fs.mkdirSync(inspection);
  // A CLI run and a second server start against the same data directory.
  inProcess(
    dataDir,
    `const { Restore } = await import(ops + "/restore.js");
const { Backup } = await import(ops + "/backup.js");
const { removeAbandonedWork } = await import(ops + "/work-claims.js");
new Restore({ dataDir });
new Backup({ dataDir });
removeAbandonedWork(dataDir);`,
  );
  assert.ok(fs.existsSync(stage));
  assert.ok(fs.existsSync(inspection));
  await restore.uploads.append(
    uploadId,
    half,
    [bytes.subarray(half)],
    bytes.length - half,
  );
  assert.deepEqual(await restore.uploads.complete(uploadId), { archiveId: uploadId });
});

test("the server's start removes work of processes that are gone", async (t) => {
  const { root, dataDir } = setup(t);
  const stage = path.join(root, `.agentpier-restore-${randomUUID()}`);
  // A process claims work and dies without releasing it.
  inProcess(
    dataDir,
    `const fs = await import("node:fs");
const path = await import("node:path");
const { claim } = await import(ops + "/work-claims.js");
const { folder } = await import(ops + "/files.js");
const stage = ${JSON.stringify(stage)};
claim(dataDir, stage);
fs.mkdirSync(stage);
const scratch = path.join(dataDir, "operations", ".snapshot-" + crypto.randomUUID());
claim(dataDir, scratch);
folder(scratch);
const upload = path.join(dataDir, "operations/restores", crypto.randomUUID() + ".apbackup.upload");
folder(path.dirname(upload));
claim(dataDir, upload);
fs.writeFileSync(upload, "partial");
fs.writeFileSync(upload + ".json", "{}");
process.exit(0);`,
  );
  // A claim never removes anything that is not work, whoever owns it.
  const keep = path.join(root, "keep");
  fs.mkdirSync(keep);
  const claims = path.join(dataDir, "operations/work");
  fs.writeFileSync(
    path.join(claims, `${randomUUID()}.json`),
    JSON.stringify({ target: keep, pid: 999999, startedAt: 0 }),
  );
  removeAbandonedWork(dataDir);
  assert.equal(fs.existsSync(stage), false);
  assert.deepEqual(
    fs
      .readdirSync(path.join(dataDir, "operations"))
      .filter((name) => name.startsWith(".")),
    [],
  );
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "operations/restores")), []);
  assert.deepEqual(fs.readdirSync(claims), []);
  assert.ok(fs.existsSync(keep));
});

test("a reused process id does not keep abandoned work alive", () => {
  assert.equal(ownerAlive(currentOwner), true);
  assert.equal(
    ownerAlive({ ...currentOwner, startedAt: currentOwner.startedAt - 1 }),
    false,
  );
  // The parent runs, but it is not the process that claimed the work.
  assert.equal(ownerAlive({ pid: process.ppid, startedAt: 0 }), false);
  assert.equal(ownerAlive({ pid: 0, startedAt: 0 }), false);
});

test("abandoned uploads expire, pending ones keep their room, and completing twice is clean", async (t) => {
  const { root, dataDir } = setup(t);
  const directory = new Restore({ dataDir }).directory;
  const uploads = new RestoreUploads(directory, dataDir);
  const bytes = await archive(root);
  const idle = uploads.begin(bytes.length);
  // Its last slice arrived more than a day ago.
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const idleFiles = uploads.files(idle.uploadId);
  fs.writeFileSync(
    idleFiles.meta,
    JSON.stringify({ size: bytes.length, createdAt: old.toISOString() }),
  );
  fs.utimesSync(idleFiles.data, old, old);
  // Any upload request sweeps uploads idle beyond a day.
  const fresh = uploads.begin(bytes.length);
  assert.throws(() => uploads.status(idle.uploadId), { status: 404 });
  assert.equal(uploads.status(fresh.uploadId).offset, 0);
  // A pending upload's remaining bytes count against the free space of the next.
  const files = uploads.files(fresh.uploadId);
  fs.writeFileSync(
    files.meta,
    JSON.stringify({ size: 2 ** 52, createdAt: new Date().toISOString() }),
  );
  assert.throws(() => uploads.begin(1), { status: 507 });
  fs.writeFileSync(
    files.meta,
    JSON.stringify({ size: bytes.length, createdAt: new Date().toISOString() }),
  );
  await uploads.append(fresh.uploadId, 0, [bytes], bytes.length);
  const results = await Promise.allSettled([
    uploads.complete(fresh.uploadId),
    uploads.complete(fresh.uploadId),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "rejected"],
  );
  assert.equal(results[1].reason.message, serverMessages.backups.uploadBusy);
  assert.equal(results[1].reason.status, 409);
  await assert.rejects(uploads.complete(fresh.uploadId), { status: 404 });
});

test("claims cover only backup work paths, and the startup sweep only backup work", (t) => {
  const { root, dataDir } = setup(t);
  const outside = path.join(root, "notes.tmp");
  const snapshotElsewhere = path.join(root, `.snapshot-${randomUUID()}`);
  for (const target of [
    outside,
    path.join(root, "a.upload"),
    snapshotElsewhere,
    path.join(dataDir, "operations", "doctor.json.tmp"),
    path.join(root, ".agentpier-restore-not-a-uuid"),
  ]) {
    assert.equal(claimable(dataDir, target), false, target);
    assert.throws(() => claim(dataDir, target));
  }
  for (const target of [
    path.join(dataDir, "operations", `.snapshot-${randomUUID()}`),
    path.join(dataDir, "operations/backups", `${randomUUID()}.apbackup.x.tmp`),
    path.join(dataDir, "operations/restores", `${randomUUID()}.apbackup.upload`),
    path.join(dataDir, "operations/restores", `.inspect-${randomUUID()}`),
    path.join(root, `.agentpier-restore-${randomUUID()}`),
  ])
    assert.equal(claimable(dataDir, target), true, target);
  // A forged claim of a dead owner on such paths removes nothing.
  fs.mkdirSync(outside);
  fs.mkdirSync(snapshotElsewhere);
  const claims = path.join(dataDir, "operations/work");
  fs.mkdirSync(claims, { recursive: true });
  for (const target of [outside, snapshotElsewhere])
    fs.writeFileSync(
      path.join(claims, `${randomUUID()}.json`),
      JSON.stringify({ target, pid: 999999, startedAt: 0, claimedAt: Date.now() }),
    );
  // Temporaries of atomic writes in operations/ (doctor report, release activation)
  // are not backup work.
  const release = path.join(
    dataDir,
    "operations",
    `post-activation-reload.json.${randomUUID()}.tmp`,
  );
  fs.writeFileSync(release, "{}");
  removeAbandonedWork(dataDir);
  assert.ok(fs.existsSync(outside));
  assert.ok(fs.existsSync(snapshotElsewhere));
  assert.ok(fs.existsSync(release));
  assert.deepEqual(fs.readdirSync(claims), []);
});

test("a claim older than a week is abandoned even when its process id still runs", (t) => {
  const { dataDir } = setup(t);
  const scratch = path.join(dataDir, "operations", `.snapshot-${randomUUID()}`);
  claim(dataDir, scratch);
  fs.mkdirSync(scratch);
  removeAbandonedWork(dataDir, { now: Date.now() + 6 * 24 * 60 * 60 * 1000 });
  assert.ok(fs.existsSync(scratch));
  removeAbandonedWork(dataDir, { now: Date.now() + 8 * 24 * 60 * 60 * 1000 });
  assert.equal(fs.existsSync(scratch), false);
});

test("start times come from /proc when ps is unavailable", (t) => {
  const { root } = setup(t);
  const proc = path.join(root, "proc");
  fs.mkdirSync(path.join(proc, "4242"), { recursive: true });
  fs.writeFileSync(path.join(proc, "stat"), "cpu 1 2 3\nbtime 1790000000\nprocesses 9\n");
  // Field 22 (start time) is 12345 ticks; the command name contains ") (".
  const fields = Array.from({ length: 50 }, (_, index) => String(index + 3));
  fields[19] = "12345";
  fs.writeFileSync(
    path.join(proc, "4242", "stat"),
    `4242 (odd) (name) ${fields.join(" ")}`,
  );
  assert.equal(procStart(4242, proc), 1790000000 * 1000 + 123450);
  assert.equal(procStart(4243, proc), null);
  if (process.platform === "linux") {
    const own = procStart(process.pid);
    assert.ok(Math.abs(own - currentOwner.startedAt) < 2000);
  }
});

test("a pending upload survives a server start and resumes where it stopped", async (t) => {
  const { root, dataDir } = setup(t);
  const directory = new Restore({ dataDir }).directory;
  const bytes = await archive(root);
  const half = Math.floor(bytes.length / 2);
  const { uploadId } = new RestoreUploads(directory, dataDir).begin(bytes.length);
  await new RestoreUploads(directory, dataDir).append(
    uploadId,
    0,
    [bytes.subarray(0, half)],
    half,
  );
  // The next server process: the claiming one is gone.
  removeAbandonedWork(dataDir, { alive: () => false });
  new Operations({ config: { dataDir } });
  const uploads = new RestoreUploads(directory, dataDir);
  assert.equal(uploads.status(uploadId).offset, half);
  await uploads.append(uploadId, half, [bytes.subarray(half)], bytes.length - half);
  assert.deepEqual(await uploads.complete(uploadId), { archiveId: uploadId });
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "operations/work")), []);
});

test("an uploaded archive is removed by a successful restore or once unused for a day", async (t) => {
  const { root, dataDir } = setup(t);
  const operations = new Operations({ config: { dataDir } });
  const bytes = await archive(root);
  const upload = async () => {
    const { uploadId } = operations.restore.uploads.begin(bytes.length);
    await operations.restore.uploads.append(uploadId, 0, [bytes], bytes.length);
    return (await operations.restore.uploads.complete(uploadId)).archiveId;
  };
  const settled = async (job) => {
    for (let i = 0; i < 400; i++) {
      const { status } = operations.jobs.get(job.id);
      if (status !== "running") return status;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const archiveId = await upload();
  const file = operations.restore.uploads.files(archiveId).archive;
  await operations.inspect({ archiveId });
  // A failed restore keeps the archive for another attempt.
  fs.mkdirSync(path.join(root, "taken"));
  const failed = operations.applyRestore({
    archiveId,
    targetDataDir: path.join(root, "taken"),
  });
  assert.equal(await settled(failed), "failed");
  assert.ok(fs.existsSync(file));
  const restored = operations.applyRestore({
    archiveId,
    targetDataDir: path.join(root, "restored"),
  });
  assert.equal(await settled(restored), "succeeded");
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(operations.inspect({ archiveId }), { status: 404 });
  // An archive nobody restores expires a day after its last use.
  const unused = await upload();
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(operations.restore.uploads.files(unused).archive, old, old);
  new Operations({ config: { dataDir } });
  assert.deepEqual(
    fs
      .readdirSync(operations.restore.directory)
      .filter((name) => name.endsWith(".apbackup")),
    [],
  );
});
