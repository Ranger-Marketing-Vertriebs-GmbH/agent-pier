import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import {
  createUpdateSnapshot,
  estimateSnapshotSize,
  restoreUpdateSnapshot,
} from "../../server/features/assistants/runtime-update-snapshot.js";
import { RuntimeUpdates } from "../../server/features/assistants/runtime-updates.js";
import {
  captureAssistants,
  isAssistantMember,
} from "../../server/features/operations/assistant-backup.js";
import { writePrivate } from "../../server/lib/storage.js";

const id = "8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e01";
const metadata = { previous: { version: "old" }, candidate: { version: "new" } };
const large = 8 * 1024 * 1024;

function fixture(t) {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "workspace-dependencies-")),
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const paths = runtimePaths(dataDir);
  const write = (relative, content, mode = 0o600) => {
    const file = path.join(paths.workspaces, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { mode });
  };
  // A Remotion-like project: its own files, installed dependencies (with nested ones)
  // and a large rendered file.
  write("video/src/index.tsx", "export {}");
  write("video/bin/render.sh", "#!/bin/sh", 0o700);
  write("video/out/render.mp4", Buffer.alloc(large, 1));
  write("video/node_modules/remotion/index.js", "module.exports = 1");
  write("video/node_modules/remotion/node_modules/nested/index.js", "nested");
  write("video/packages/player/node_modules/react/index.js", "react");
  write("node_modules/top/index.js", "top-level");
  fs.symlinkSync("../src/index.tsx", path.join(paths.workspaces, "video/bin/entry"));
  // A link named node_modules is a link, not installed dependencies: it stays.
  fs.symlinkSync("../video/src", path.join(paths.workspaces, "video/src/node_modules"));
  const backup = path.join(paths.root, "backups", id);
  fs.mkdirSync(path.dirname(backup), { mode: 0o700 });
  return { dataDir, paths, backup, payload: path.join(backup, "payload") };
}

test("update snapshots leave installed dependencies out and restore without them", async (t) => {
  const { paths, backup, payload } = fixture(t);
  const estimate = await estimateSnapshotSize(paths);
  let reported = 0;
  const manifest = await createUpdateSnapshot(paths, backup, metadata, {
    onProgress: (bytes) => (reported += bytes),
  });
  assert.deepEqual(manifest.omittedDependencies, [
    "workspaces/node_modules",
    "workspaces/video/node_modules",
    "workspaces/video/packages/player/node_modules",
  ]);
  const copied = (relative) => path.join(payload, "workspaces", relative);
  for (const relative of manifest.omittedDependencies)
    assert.equal(fs.existsSync(path.join(payload, relative)), false, relative);
  assert.equal(fs.readlinkSync(copied("video/bin/entry")), "../src/index.tsx");
  assert.equal(fs.readlinkSync(copied("video/src/node_modules")), "../video/src");
  assert.equal(fs.statSync(copied("video/bin/render.sh")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(copied("video/out/render.mp4")).size, large);
  // Progress counts exactly what the estimate counted, dependencies excluded.
  assert.equal(reported, estimate);
  assert.ok(estimate > large && estimate < large + 64 * 1024, `${estimate}`);

  fs.writeFileSync(path.join(paths.workspaces, "video/src/index.tsx"), "changed");
  const restored = await restoreUpdateSnapshot(paths, backup);
  assert.deepEqual(restored.omittedDependencies, manifest.omittedDependencies);
  const live = (relative) => path.join(paths.workspaces, relative);
  assert.equal(fs.readFileSync(live("video/src/index.tsx"), "utf8"), "export {}");
  assert.equal(fs.readFileSync(live("video/bin/entry"), "utf8"), "export {}");
  assert.equal(fs.lstatSync(live("video/src/node_modules")).isSymbolicLink(), true);
  assert.deepEqual(fs.readFileSync(live("video/out/render.mp4")), Buffer.alloc(large, 1));
  // The agent installs its dependencies again after a rollback.
  assert.equal(fs.existsSync(live("video/node_modules")), false);
  assert.equal(fs.existsSync(live("node_modules")), false);
});

test("the update status reports snapshot progress against the estimate", async (t) => {
  const { dataDir, paths } = fixture(t);
  writePrivate(path.join(paths.root, "runtime.json"), { version: "old" });
  const samples = [];
  const runtime = {
    status: () => ({ availability: "disabled" }),
    stop: async () => {},
    start: async () => {},
  };
  const maintenance = {
    enter: async () => {},
    blockers: async () => [],
    quiesce: async () => {},
    validate: async () => {},
    leave: async () => {},
  };
  const updates = new RuntimeUpdates({
    dataDir,
    runtime,
    maintenance,
    stage: async () => ({ version: "new" }),
    migrate: async () => {},
  });
  await updates.stage();
  const estimate = await estimateSnapshotSize(paths);
  let done = false;
  const poll = (async () => {
    while (!done) {
      const status = updates.status();
      if (status.phase === "snapshotting") samples.push(status.snapshotProgress);
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  await updates.activate();
  done = true;
  await poll;
  assert.ok(samples.length > 0, "the status was read while snapshotting");
  for (const progress of samples) {
    assert.equal(progress.totalBytes, estimate);
    assert.ok(progress.copiedBytes >= 0 && progress.copiedBytes <= estimate);
  }
  assert.equal(updates.status().phase, "complete");
  assert.equal(updates.status().snapshotProgress, null);
});

test("host backups leave installed dependencies in workspaces out", async (t) => {
  const { dataDir } = fixture(t);
  const result = await captureAssistants({
    dataDir,
    id: "8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e02",
    withCredentials: false,
    includeHistory: true,
  });
  const names = result.files.map((member) => member.path);
  assert.ok(names.includes("assistants/workspaces/video/src/index.tsx"));
  assert.ok(names.includes("assistants/workspaces/video/out/render.mp4"));
  assert.equal(
    names.some((name) => name.includes("/node_modules/")),
    false,
    names.join("\n"),
  );
  // Older backups that archived them still restore.
  assert.equal(
    isAssistantMember("assistants/workspaces/video/node_modules/remotion/index.js"),
    true,
  );
});
