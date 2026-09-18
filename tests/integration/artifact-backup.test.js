import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { issue } from "../helpers/session-mcp.js";
import { ArtifactService } from "../../server/features/artifacts/artifact-service.js";
import { Restore } from "../../server/features/operations/restore.js";
for (const includeHistory of [false, true])
  test(`artifact backup restores private content and pin lifecycle (history ${includeHistory})`, async (t) => {
    const f = await applicationFixture(t);
    const issued = await issue(f, { choices: true });
    const project = f.application.memory.projects().projects[0];
    await fs.writeFile(path.join(f.home, "report.html"), "<h1>saved</h1>");
    const context = { sessionId: issued.session.id, projectId: project.id, cwd: f.home };
    const publish = () =>
      f.application.artifacts.publish(
        context,
        { requestId: randomUUID(), title: "Report", sourcePath: "report.html" },
        async () => {},
      );
    const kept = await publish(),
      ordinary = await publish();
    await f.application.artifacts.setPinned(kept.id, true);
    const backup = await f.application.operations.backup.create({ includeHistory });
    const target = path.join(f.root, "restored");
    await new Restore({ dataDir: f.dataDir }).apply({
      archive: backup.file,
      targetDataDir: target,
    });
    const restored = new ArtifactService({
      dataDir: target,
      sessionExists: () => includeHistory,
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
    if (includeHistory) assert.equal((await restored.get(ordinary.id)).pinned, false);
    else await assert.rejects(restored.get(ordinary.id), { status: 404 });
    await assert.rejects(fs.stat(path.join(target, "session-mcp")), { code: "ENOENT" });
  });
