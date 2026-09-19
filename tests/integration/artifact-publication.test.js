import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { artifactFixture } from "../helpers/artifacts.js";
const input = (extra = {}) => ({
  requestId: randomUUID(),
  title: "Report",
  sourcePath: "report.html",
  ...extra,
});
const valid = async () => {};
test("publication copies data, replays a receipt and atomically updates a stable artifact", async (t) => {
  const f = await artifactFixture(t);
  await fs.writeFile(path.join(f.workspace, "report.html"), "<h1>first</h1>");
  const request = input();
  const first = await f.service.publish(f.context, request, valid);
  await fs.writeFile(path.join(f.workspace, "report.html"), "<h1>second</h1>");
  assert.deepEqual(await f.service.publish(f.context, request, valid), first);
  await assert.rejects(
    f.service.publish(f.context, { ...request, title: "Other" }, valid),
    { status: 409 },
  );
  const snapshot = await f.service.snapshot(first.id);
  assert.equal(
    Buffer.from(snapshot.files[0].base64, "base64").toString(),
    "<h1>first</h1>",
  );
  const updated = await f.service.publish(
    f.context,
    input({ artifactId: first.id }),
    valid,
  );
  assert.equal(updated.id, first.id);
  assert.notEqual((await f.service.snapshot(first.id)).generation, snapshot.generation);
  await f.restart();
  assert.equal((await f.service.get(first.id)).title, "Report");
  await fs.rm(path.join(f.workspace, "report.html"));
  assert.equal(
    Buffer.from(
      (await f.service.snapshot(first.id)).files[0].base64,
      "base64",
    ).toString(),
    "<h1>second</h1>",
  );
});
test("failed replacement, revoked identity and foreign sessions preserve prior publication", async (t) => {
  const f = await artifactFixture(t, { publicationBytes: 40 });
  await fs.writeFile(path.join(f.workspace, "report.html"), "first");
  const first = await f.service.publish(f.context, input(), valid);
  await assert.rejects(
    f.service.publish(
      { ...f.context, sessionId: "session-two" },
      input({ artifactId: first.id }),
      valid,
    ),
    { status: 403 },
  );
  await assert.rejects(
    f.service.publish(f.context, input({ artifactId: first.id }), () => {
      throw Object.assign(Error(), { status: 403 });
    }),
    { status: 403 },
  );
  await fs.writeFile(path.join(f.workspace, "report.html"), "x".repeat(41));
  await assert.rejects(
    f.service.publish(f.context, input({ artifactId: first.id }), valid),
    { status: 413 },
  );
  assert.equal(
    Buffer.from(
      (await f.service.snapshot(first.id)).files[0].base64,
      "base64",
    ).toString(),
    "first",
  );
});
test("source selection rejects traversal, symlinks, hard links and unsupported files", async (t) => {
  const f = await artifactFixture(t);
  await fs.writeFile(path.join(f.root, "secret.html"), "private");
  await fs.symlink(path.join(f.root, "secret.html"), path.join(f.workspace, "link.html"));
  await fs.link(path.join(f.root, "secret.html"), path.join(f.workspace, "hard.html"));
  await fs.writeFile(path.join(f.workspace, "secret.env"), "private");
  for (const sourcePath of ["../secret.html", "link.html", "hard.html", "secret.env"])
    await assert.rejects(f.service.publish(f.context, input({ sourcePath }), valid));
  assert.equal((await f.service.list({ sessionId: f.context.sessionId })).total, 0);
});
test("directory publications enforce entrypoint, file count and total storage budget", async (t) => {
  const f = await artifactFixture(t, { files: 2, totalBytes: 100000 });
  await fs.mkdir(path.join(f.workspace, "site"));
  for (const name of ["index.html", "main.js", "style.css"])
    await fs.writeFile(path.join(f.workspace, "site", name), "test");
  await assert.rejects(
    f.service.publish(f.context, input({ sourcePath: "site" }), valid),
  );
  await assert.rejects(
    f.service.publish(
      f.context,
      input({ sourcePath: "site", entrypoint: "index.html" }),
      valid,
    ),
    { status: 413 },
  );
  await fs.rm(path.join(f.workspace, "site/style.css"));
  const result = await f.service.publish(
    f.context,
    input({ sourcePath: "site", entrypoint: "index.html" }),
    valid,
  );
  assert.equal((await f.service.snapshot(result.id)).files.length, 2);
});
