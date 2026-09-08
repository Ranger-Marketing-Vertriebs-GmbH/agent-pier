import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatAttachments } from "../../server/features/chat/chat-attachments.js";

test("chat uploads preserve bytes, use private unique paths and reject invalid input", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-uploads-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const session = { id: "one", tool: "claude", status: "running" };
  const uploads = new ChatAttachments({
    dataDir,
    sessions: { get: async () => session },
  });
  const body = Buffer.from([0, 255, 42]);
  const first = await uploads.save("one", "photo.png", body);
  const second = await uploads.save("one", "photo.png", body);
  assert.notEqual(first.path, second.path);
  assert.deepEqual(await fs.readFile(first.path), body);
  assert.equal((await fs.stat(first.path)).mode & 0o777, 0o600);
  for (const name of ["../secret", "a/b", "a\\b", "..", "bad\nname"])
    await assert.rejects(uploads.save("one", name, body), { status: 400 });
  await assert.rejects(
    uploads.save("one", "large.bin", Buffer.alloc(10 * 1024 * 1024 + 1)),
    { status: 413 },
  );
  session.status = "stopped";
  await assert.rejects(uploads.save("one", "photo.png", body), { status: 409 });
  await uploads.discard("one");
  await assert.rejects(fs.stat(first.path), { code: "ENOENT" });
});

test("session cleanup waits for an upload already in progress", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-upload-race-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const lookup = Promise.withResolvers();
  let cleanupStarted = false;
  const remove = fs.rm;
  t.mock.method(fs, "rm", (...args) => {
    cleanupStarted = true;
    return remove(...args);
  });
  const uploads = new ChatAttachments({
    dataDir,
    sessions: { get: () => lookup.promise },
  });
  const saving = uploads.save("one", "notes.txt", Buffer.from("notes"));
  const discarding = uploads.discard("one");
  const startedBeforeUploadFinished = cleanupStarted;
  lookup.resolve({ status: "running", tool: "claude" });
  const [file] = await Promise.all([saving, discarding]);
  assert.equal(startedBeforeUploadFinished, false);
  await assert.rejects(fs.stat(file.path), { code: "ENOENT" });
});
