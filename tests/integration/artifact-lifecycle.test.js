import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { artifactFixture } from "../helpers/artifacts.js";
const input = () => ({
  requestId: randomUUID(),
  title: "Report",
  sourcePath: "report.html",
});
test("retired sessions lose unpinned artifacts while pinned orphans remain until unpinned", async (t) => {
  const f = await artifactFixture(t);
  await fs.writeFile(path.join(f.workspace, "report.html"), "<h1>report</h1>");
  const kept = await f.service.publish(f.context, input(), async () => {});
  const removed = await f.service.publish(f.context, input(), async () => {});
  await f.service.setPinned(kept.id, true);
  await f.service.retireSession(f.context.sessionId);
  f.sessions.delete(f.context.sessionId);
  await f.restart();
  await assert.rejects(f.service.get(removed.id), { status: 404 });
  assert.equal((await f.service.get(kept.id)).orphaned, true);
  assert.equal((await f.service.list({ projectId: f.context.projectId })).total, 1);
  await assert.rejects(
    f.service.publish(f.context, input(), async () => {}),
    { status: 409 },
  );
  await f.service.setPinned(kept.id, false);
  await assert.rejects(f.service.get(kept.id), { status: 404 });
});
test("manual deletion is idempotent and restart cleanup removes abandoned generations", async (t) => {
  const f = await artifactFixture(t);
  await fs.writeFile(path.join(f.workspace, "report.html"), "report");
  const request = input();
  const artifact = await f.service.publish(f.context, request, async () => {});
  await f.service.setPinned(artifact.id, true);
  await f.service.delete(artifact.id);
  await f.service.delete(artifact.id);
  await assert.rejects(f.service.publish(f.context, request, async () => {}));
  const orphan = path.join(f.dataDir, "artifacts", "generations", randomUUID());
  await fs.mkdir(orphan);
  await fs.writeFile(path.join(orphan, "unused"), "unused");
  await f.restart();
  await assert.rejects(fs.stat(orphan), { code: "ENOENT" });
});
test("deletion wins over a replacement waiting for authorization", async (t) => {
  const f = await artifactFixture(t);
  await fs.writeFile(path.join(f.workspace, "report.html"), "report");
  const first = await f.service.publish(f.context, input(), async () => {});
  let release, reached;
  const ready = new Promise((resolve) => {
    reached = resolve;
  });
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  const updating = f.service.publish(
    f.context,
    { ...input(), artifactId: first.id },
    async () => {
      reached();
      await paused;
    },
  );
  const rejected = assert.rejects(updating, { status: 404 });
  await ready;
  const deleting = f.service.delete(first.id);
  release();
  await rejected;
  await deleting;
  await assert.rejects(f.service.get(first.id), { status: 404 });
});
test("failed physical deletion stays invisible and is retried by cleanup", async (t) => {
  const f = await artifactFixture(t);
  await fs.writeFile(path.join(f.workspace, "report.html"), "report");
  const first = await f.service.publish(f.context, input(), async () => {});
  const original = fs.rm;
  const stub = t.mock.method(fs, "rm", async (file, options) => {
    if (String(file).includes("generations"))
      throw Object.assign(Error("fixture"), { code: "EACCES" });
    return original(file, options);
  });
  await f.service.delete(first.id);
  await assert.rejects(f.service.get(first.id), { status: 404 });
  assert.ok((await f.service.usage()).pendingCleanupBytes > 0);
  stub.mock.restore();
  await f.service.reconcile();
  assert.equal((await f.service.usage()).pendingCleanupBytes, 0);
});
