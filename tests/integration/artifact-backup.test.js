import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { issue } from "../helpers/session-mcp.js";
import { ArtifactService } from "../../server/features/artifacts/artifact-service.js";
import { Restore } from "../../server/features/operations/restore.js";
import { readArchiveHeader } from "../../server/features/operations/archive-v2.js";
import { loadArchive } from "../helpers/backup-archive.js";

const passphrase = "artifact backup fixture phrase";
// Unpinned artifacts are private content: only sealed, in backups with a passphrase.
for (const [label, options, sealed] of [
  ["without history", { includeHistory: false }, false],
  ["history without a passphrase", { includeHistory: true }, false],
  [
    "history with a passphrase",
    { includeHistory: true, withCredentials: true, passphrase },
    true,
  ],
])
  test(`artifact backup restores private content and pin lifecycle (${label})`, async (t) => {
    const f = await applicationFixture(t);
    const issued = await issue(f, { choices: true });
    const project = f.application.memory.projects().projects[0];
    await fs.writeFile(path.join(f.project, "report.html"), "<h1>saved</h1>");
    const context = {
      sessionId: issued.session.id,
      projectId: project.id,
      cwd: f.project,
    };
    const publish = () =>
      f.application.artifacts.publish(
        context,
        { requestId: randomUUID(), title: "Report", sourcePath: "report.html" },
        async () => {},
      );
    const kept = await publish(),
      ordinary = await publish();
    await f.application.artifacts.setPinned(kept.id, true);
    const backup = await f.application.operations.backup.create(options);
    const header = await readArchiveHeader(backup.file);
    const publicNames = header.members.map((member) => member.path);
    // The unpinned record, its receipt and its files are never public members.
    const live = JSON.parse(
      await fs.readFile(path.join(f.dataDir, "artifacts/index.json"), "utf8"),
    );
    const unpinnedFolder = `artifacts/generations/${live.records[ordinary.id].generation}/`;
    assert.equal(publicNames.includes("artifacts/unpinned.json"), false);
    const member = loadArchive(backup.file).files.find(
      (entry) => entry.path === "artifacts/index.json",
    );
    const index = JSON.parse(Buffer.from(member.content, "base64").toString());
    assert.equal(index.records[ordinary.id].deleted, true);
    assert.equal(
      Object.values(index.receipts).some((receipt) => receipt.result.id === ordinary.id),
      false,
    );
    assert.equal(
      publicNames.some((name) => name.startsWith(unpinnedFolder)),
      false,
    );
    assert.equal(
      header.members.some((member) => member.kind === "sealed"),
      sealed,
    );
    const target = path.join(f.root, "restored");
    await new Restore({ dataDir: f.dataDir }).apply({
      archive: backup.file,
      targetDataDir: target,
      ...(sealed && { passphrase }),
    });
    const restored = new ArtifactService({
      dataDir: target,
      sessionExists: () => sealed,
      pollMs: 0,
    });
    t.after(() => restored.close());
    await restored.ready;
    const snapshot = await restored.snapshot(kept.id);
    assert.equal(
      Buffer.from(snapshot.files[0].base64, "base64").toString(),
      "<h1>saved</h1>",
    );
    assert.equal(snapshot.artifact.pinned, true);
    if (sealed) assert.equal((await restored.get(ordinary.id)).pinned, false);
    else await assert.rejects(restored.get(ordinary.id), { status: 404 });
    await assert.rejects(fs.stat(path.join(target, "session-mcp")), { code: "ENOENT" });
  });
