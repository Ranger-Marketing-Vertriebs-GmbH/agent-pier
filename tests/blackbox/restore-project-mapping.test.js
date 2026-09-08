import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { createApplication } from "../../server/app.js";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";

test("restore rejects colliding mappings and opens Unicode project memory with unchanged pipeline definitions", async (t) => {
  const f = await applicationFixture(t);
  const oldPaths = ["source α", "source β"].map((name) => path.join(f.root, name));
  const newPath = path.join(f.root, "Ziel 日本語 🧡");
  for (const cwd of [...oldPaths, newPath]) await fs.mkdir(cwd);
  const first = await f.application.memory.register(oldPaths[0]);
  const second = await f.application.memory.register(oldPaths[1]);
  f.application.memory.write(first.id, {
    title: "Portable knowledge",
    content: "Keep this fact",
  });
  const definitions = f.application.pipelineDefinitions;
  const profile = definitions
    .listProfiles()
    .find((item) => item.seedKey === "implementer");
  const pipeline = definitions.savePipeline({
    name: "Portable pipeline",
    graph: {
      entry: "stage",
      nodes: [{ id: "stage", kind: "profile", profileId: profile.id }],
      edges: [],
    },
  });
  const steps = [
    { name: "Check", command: "node --version", timeoutMs: 1000, blocking: true },
  ];
  definitions.saveVerification(first.id, { steps });
  const backup = await new Backup({ dataDir: f.dataDir }).create();
  const restore = new Restore({ dataDir: f.dataDir });
  const targetDataDir = path.join(f.root, "restored");
  for (const projectMap of [
    { [first.id]: newPath, [second.id]: newPath },
    { [first.id]: oldPaths[1] },
  ]) {
    await assert.rejects(
      restore.apply({ archive: backup.file, targetDataDir, projectMap }),
      /collide/,
    );
    await assert.rejects(fs.stat(targetDataDir), { code: "ENOENT" });
  }
  await restore.apply({
    archive: backup.file,
    targetDataDir,
    projectMap: { [first.id]: newPath },
  });
  const restored = await createApplication({
    dataDir: targetDataDir,
    home: f.home,
    port: 0,
  });
  try {
    const moved = await restored.memory.register(newPath);
    assert.equal(restored.memory.list(moved.id).items[0].content, "Keep this fact");
    assert.deepEqual(restored.pipelineDefinitions.getPipeline(pipeline.id), pipeline);
    assert.deepEqual(restored.pipelineDefinitions.getProfile(profile.id), profile);
    assert.deepEqual(restored.pipelineDefinitions.getVerification(moved.id).steps, steps);
    assert.equal((await restored.sessions.list()).length, 0);
    assert.equal(f.application.memory.list(first.id).items[0].content, "Keep this fact");
  } finally {
    await restored.close();
  }
});
