import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolInstaller } from "../../server/features/tools/tool-installer.js";

test("installer stays running until failed-install cleanup is finished", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentpier-install-finalize-"),
  );
  const npmCli = path.join(directory, "npm.cjs");
  await fs.writeFile(npmCli, "process.exit(0)");
  const installer = new ToolInstaller({
    dataDir: directory,
    home: directory,
    npmCli,
    detect: () => [],
  });
  const remove = fs.rm.bind(fs);
  let releaseCleanup, startedCleanup;
  const cleanupStarted = new Promise((resolve) => {
    startedCleanup = resolve;
  });
  const cleanupReleased = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  t.mock.method(fs, "rm", async (file, options) => {
    if (String(file).startsWith(path.join(directory, "clis", ".install-"))) {
      startedCleanup();
      await cleanupReleased;
    }
    return remove(file, options);
  });
  t.after(async () => {
    releaseCleanup();
    await installer.close();
    await remove(directory, { recursive: true, force: true });
  });
  installer.start("claude", "npm");
  await cleanupStarted;
  assert.equal(
    installer.list().installations.find((job) => job.tool === "claude").status,
    "running",
  );
  releaseCleanup();
  await installer.close();
  const result = installer.list().installations.find((job) => job.tool === "claude");
  assert.equal(result.status, "failed");
  assert.ok(result.finishedAt);
  assert.deepEqual(
    (await fs.readdir(path.join(directory, "clis"))).filter((name) =>
      name.startsWith(".install-"),
    ),
    [],
  );
});
