import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { historicalOnly } from "../../server/features/operations/restore-data.js";

test("restored history cannot carry a queued restart or live SSH tool generation", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-reload-restore-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "sessions"));
  const file = path.join(root, "sessions", "fixture.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      id: "fixture",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      reload: { state: "waiting", nativeId: "native-fixture" },
      sshTools: { enabled: true, generation: "old-generation" },
      restartGeneration: "old-generation",
    }),
  );
  historicalOnly(root);
  const restored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(restored.status, "stopped");
  assert.equal(restored.imported.historyOnly, true);
  assert.equal(restored.reload, undefined);
  assert.equal(restored.sshTools, undefined);
  assert.equal(restored.restartGeneration, undefined);
  assert.equal(restored.createdAt, "2026-01-01T00:00:00.000Z");
});
