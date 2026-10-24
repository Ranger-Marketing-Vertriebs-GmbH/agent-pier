import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Releases } from "../../server/features/operations/releases.js";
import { Operations } from "../../server/features/operations/operations.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";

const STAGED_ID = "0b6c1d52-7e1f-4b55-9c1e-1a2b3c4d5e6f";

// Active 1.2.0, older 1.0.0, newer 1.3.0 (staged) and 1.4.0 (installed, no receipt).
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ap-release-staged-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data"),
    installRoot = path.join(root, "install");
  await fs.mkdir(dataDir);
  for (const version of ["1.0.0", "1.2.0", "1.3.0", "1.4.0"]) {
    const dir = path.join(installRoot, "releases", version);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "release.json"), JSON.stringify({ version }));
  }
  await fs.symlink("releases/1.2.0", path.join(installRoot, "current"));
  const releases = new Releases({ dataDir, installRoot, processes: () => "" });
  await fs.writeFile(
    path.join(releases.directory, `${STAGED_ID}.json`),
    JSON.stringify({ id: STAGED_ID, version: "1.3.0" }),
  );
  return releases;
}
const entry = (r, version) =>
  r.cleanupStatus().versions.find((item) => item.version === version);

test("a staged release newer than the active one can be deleted with its receipt", async (t) => {
  const r = await fixture(t);
  assert.deepEqual(
    r.status().staged.map((item) => item.version),
    ["1.3.0"],
  );
  const staged = entry(r, "1.3.0");
  assert.equal(staged.canDelete, true);
  assert.equal(staged.deleteReason, null);
  assert.equal(staged.newer, true);
  assert.deepEqual(staged.stagedIds, [STAGED_ID]);
  assert.deepEqual(await r.cleanup(["1.3.0"]), {
    removedVersions: ["1.3.0"],
    stagedIds: { "1.3.0": STAGED_ID },
  });
  await assert.rejects(fs.stat(path.join(r.installRoot, "releases/1.3.0")));
  assert.deepEqual(await fs.readdir(r.directory), []);
  assert.deepEqual(r.status().staged, []);
  assert.equal(entry(r, "1.3.0"), undefined);
  assert.equal(await fs.readlink(path.join(r.installRoot, "current")), "releases/1.2.0");
});

test("the active release and a newer release without a receipt stay protected", async (t) => {
  const r = await fixture(t);
  // A receipt for the active version (after activation) never makes it deletable.
  await fs.writeFile(
    path.join(r.directory, "aaaa.json"),
    JSON.stringify({ id: "aaaa", version: "1.2.0" }),
  );
  assert.equal(entry(r, "1.2.0").deleteReason, "active");
  assert.equal(entry(r, "1.4.0").deleteReason, "newer");
  assert.equal(entry(r, "1.4.0").newer, true);
  assert.deepEqual(entry(r, "1.4.0").stagedIds, []);
  assert.equal(entry(r, "1.0.0").newer, false);
  for (const version of ["1.2.0", "1.4.0"]) await assert.rejects(r.cleanup([version]));
  assert.ok(await fs.stat(path.join(r.installRoot, "releases/1.4.0")));
});

test("a busy activation or a running process keeps a staged release", async (t) => {
  const r = await fixture(t);
  const lock = path.join(r.dataDir, "operations/release-activation.lock");
  await fs.writeFile(lock, "fixture lock");
  assert.equal(entry(r, "1.3.0").deleteReason, "busy");
  await assert.rejects(r.cleanup(["1.3.0"]));
  await fs.unlink(lock);
  const dir = `${r.installRoot}/releases/1.3.0`;
  r.processes = () => `  100     1 ${dir}/bin/node ${dir}/server/terminal-launcher.js`;
  assert.equal(entry(r, "1.3.0").deleteReason, "inUse");
  await assert.rejects(r.cleanup(["1.3.0"]));
  // Orphans of a newer version are never stopped from here, even when staged.
  r.processes = () => `  702     1 node ${dir}/bin/node -e x`;
  assert.equal(entry(r, "1.3.0").canDelete, true);
  await assert.rejects(r.stopOrphans("1.3.0", [702]), { status: 400 });
  assert.ok(await fs.stat(dir));
  assert.equal((await fs.readdir(r.directory)).length, 1);
});

test("deleting a staged release records its staged id in the audit", async (t) => {
  const r = await fixture(t);
  const audit = new AuditStore({ dataDir: r.dataDir });
  t.after(() => audit.close());
  const operations = new Operations({
    config: { dataDir: r.dataDir },
    audit,
    withSnapshotBarrier: (fn) => fn(),
    releaseOptions: { installRoot: r.installRoot, processes: () => "" },
  });
  t.after(() => operations.close());
  const job = operations.cleanupReleases({ versions: ["1.3.0", "1.0.0"] });
  await operations.jobs.close();
  const finished = operations.jobs.get(job.id);
  assert.equal(finished.status, "succeeded", finished.error);
  const events = audit
    .list()
    .events.filter((event) => event.action === "release.deleted")
    .map((event) => event.details)
    .sort((a, b) => a.version.localeCompare(b.version));
  assert.deepEqual(events, [
    { version: "1.0.0" },
    { version: "1.3.0", stagedId: STAGED_ID },
  ]);
});
