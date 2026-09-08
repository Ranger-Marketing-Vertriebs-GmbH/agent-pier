import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Operations } from "../../server/features/operations/operations.js";
test("operations canonicalize the configured root without changing the application's session identity", async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-operations-root-")),
  );
  const dataDir = path.join(root, "data"),
    alias = path.join(root, "alias");
  fs.mkdirSync(dataDir);
  fs.symlinkSync(dataDir, alias);
  let operations;
  t.after(async () => {
    await operations?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const config = { dataDir: alias, home: root };
  operations = new Operations({ config });
  assert.equal(config.dataDir, alias);
  const job = operations.createBackup({ includeHistory: false });
  await operations.close();
  assert.equal(operations.jobs.get(job.id).status, "succeeded");
});
