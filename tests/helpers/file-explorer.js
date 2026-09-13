import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeFileScope } from "../../server/features/files/file-scope.js";

export async function fileFixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-files-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    project = path.join(home, "project"),
    dataDir = path.join(root, "data");
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(project, { mode: 0o700 });
  await fs.mkdir(dataDir, { mode: 0o700 });
  return {
    root,
    home,
    project,
    dataDir,
    globalScope: await makeFileScope({ home }),
    projectScope: await makeFileScope({ home, session: { id: "fixture", cwd: project } }),
  };
}

export async function waitForFileJob(
  f,
  id,
  {
    base = "/api/files",
    states = ["completed", "partially_completed", "failed", "cancelled", "interrupted"],
    timeout = 5000,
  } = {},
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = await f.request(`${base}/jobs/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    assert.equal(response.status, 200);
    const job = await response.json();
    if (states.includes(job.status)) return job;
    await delay(10);
  }
  assert.fail(
    `Fixture file job ${id} did not reach ${states.join(", ")} in ${timeout}ms`,
  );
}
