import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomFillSync } from "node:crypto";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { writeCliProfiles } from "../helpers/cli-profile-fixture.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { writeAssistantFeature } from "../../server/features/assistants/assistant-feature.js";

// CI streams a few hundred MiB; AGENTPIER_BACKUP_LARGE_MB=4096 runs the large case.
const totalMiB = Number(process.env.AGENTPIER_BACKUP_LARGE_MB || 256);
const MiB = 1024 * 1024;
const passphrase = "large backup fixture passphrase";
const workspaceMiB = 160;

/** Peak resident memory above the start while `run` is pending. */
async function peakGrowth(run) {
  global.gc?.();
  const start = process.memoryUsage().rss;
  let peak = start;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 5);
  try {
    const result = await run();
    return { result, growth: Math.max(peak, process.memoryUsage().rss) - start };
  } finally {
    clearInterval(timer);
  }
}

test(`a ${totalMiB} MiB profile history streams through backup and restore in bounded memory`, async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-large-")),
  );
  const dataDir = path.join(root, "data");
  const db = writeCliProfiles(dataDir);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  // Random content does not compress, so the archive is as large as the history.
  const sessions = path.join(dataDir, "profiles/codex-work/codex/sessions/2026/10/12");
  const chunk = Buffer.alloc(16 * MiB);
  for (let written = 0, index = 0; written < totalMiB * MiB; index++) {
    const size = Math.min(64 * MiB, totalMiB * MiB - written);
    const file = path.join(sessions, `rollout-${index}.jsonl`);
    const fd = fs.openSync(file, "w", 0o600);
    for (let left = size; left > 0; left -= chunk.length) {
      randomFillSync(chunk);
      fs.writeSync(fd, chunk, 0, Math.min(left, chunk.length));
    }
    fs.closeSync(fd);
    written += size;
  }
  // Agent workspaces stream too: one beyond the former 128 MiB agent budget.
  new AssistantStore({ dataDir }).close();
  writeAssistantFeature(dataDir, { enabled: true });
  const workspace = path.join(dataDir, "assistants/workspaces/main");
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  for (let index = 0; index < workspaceMiB / 16; index++) {
    randomFillSync(chunk);
    fs.writeFileSync(path.join(workspace, `data-${index}.bin`), chunk, { mode: 0o600 });
  }
  const backup = new Backup({ dataDir, home: path.join(root, "home") });
  const created = await peakGrowth(() =>
    backup.create({ includeHistory: true, withCredentials: true, passphrase }),
  );
  const archiveBytes = created.result.backup.bytes;
  assert.ok(
    archiveBytes > (totalMiB + workspaceMiB) * MiB,
    "the archive holds the history and the agent workspace",
  );
  assert.equal(
    created.result.manifest.omissions.includes("Agent workspaces too large"),
    false,
  );
  const limit = Math.min(160 * MiB, archiveBytes / 2);
  assert.ok(
    created.growth < limit,
    `backup grew RSS by ${(created.growth / MiB).toFixed(0)} MiB`,
  );
  // Uploads stream to disk as well, far past the former 256 MiB request limit.
  const restore = new Restore({ dataDir });
  const uploaded = await peakGrowth(() =>
    restore.upload(fs.createReadStream(created.result.file), {
      expectedBytes: archiveBytes,
    }),
  );
  assert.ok(uploaded.growth < limit, `upload grew RSS by ${uploaded.growth}`);
  fs.rmSync(path.join(restore.directory, `${uploaded.result.archiveId}.apbackup`));
  const target = path.join(root, "restored");
  const restored = await peakGrowth(() =>
    new Restore({ dataDir }).apply({
      archive: created.result.file,
      targetDataDir: target,
      passphrase,
    }),
  );
  assert.ok(
    restored.growth < limit,
    `restore grew RSS by ${(restored.growth / MiB).toFixed(0)} MiB`,
  );
  assert.equal(
    fs.statSync(
      path.join(target, "profiles/codex-work/codex/sessions/2026/10/12/rollout-0.jsonl"),
    ).size,
    Math.min(64, totalMiB) * MiB,
  );
  assert.equal(
    fs.statSync(path.join(target, "assistants/workspaces/main/data-0.bin")).size,
    16 * MiB,
  );
  t.diagnostic(
    `archive ${(archiveBytes / MiB).toFixed(0)} MiB; RSS growth backup ${(created.growth / MiB).toFixed(0)} MiB, restore ${(restored.growth / MiB).toFixed(0)} MiB`,
  );
});
