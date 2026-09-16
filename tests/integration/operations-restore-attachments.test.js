import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { ChatAttachments } from "../../server/features/chat/chat-attachments.js";
import { sessionsRoutes } from "../../server/http/routes/sessions.js";

test("deleting restored history preserves source attachments and removes stale grants", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "restore-images-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    target = path.join(root, "target");
  const directory = path.join(source, "chat-attachments/account/session");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "image.png"), "original");
  await fs.mkdir(path.join(source, "sessions"));
  await fs.writeFile(
    path.join(source, "sessions/session.json"),
    JSON.stringify({
      id: "session",
      status: "running",
      tool: "codex",
      attachments: { directory },
    }),
  );
  const backup = await new Backup({ dataDir: source, home: root }).create();
  await new Restore({ dataDir: source }).apply({
    archive: backup.file,
    targetDataDir: target,
  });
  const file = path.join(target, "sessions/session.json");
  const restored = JSON.parse(await fs.readFile(file));
  const sessions = { get: async () => restored, remove: () => fs.unlink(file) };
  const noop = { discard: async () => {}, remove: () => {} };
  const app = express();
  app.use(
    sessionsRoutes({
      sessions,
      chatAttachments: new ChatAttachments({ dataDir: target, sessions }),
      chatDelivery: noop,
      requests: noop,
      memoryIntegration: noop,
      activity: noop,
      chat: noop,
      bindings: noop,
      github: noop,
      models: noop,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/sessions/session`,
    { method: "DELETE" },
  );
  assert.equal(response.status, 204);
  assert.equal(await fs.readFile(path.join(directory, "image.png"), "utf8"), "original");
  assert.equal(restored.attachments, undefined);
});
