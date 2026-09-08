import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChatAttachments,
  attachmentDirectory,
} from "../../server/features/chat/chat-attachments.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);

function fixture(t, session = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-attachments-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const record = {
    id: "session-one",
    accountId: "account-one",
    tool: "claude",
    status: "running",
    attachments: {
      directory: attachmentDirectory(dataDir, "account-one", "session-one"),
    },
    ...session,
  };
  const sessions = {
    async get(id) {
      if (id !== record.id) throw Object.assign(new Error("Missing"), { status: 404 });
      return record;
    },
  };
  return { dataDir, record, store: new ChatAttachments({ dataDir, sessions }) };
}

test("a valid image is stored inside the session directory with a generated name", async (t) => {
  const f = fixture(t);
  const stored = await f.store.store("session-one", {
    name: "Screenshot 2026.png",
    data: png.toString("base64"),
  });
  assert.equal(stored.name, "Screenshot 2026.png");
  assert.equal(path.dirname(stored.path), f.record.attachments.directory);
  assert.match(path.basename(stored.path), /^\d{8}T\d{6}-[0-9a-f]{8}\.png$/);
  assert.deepEqual(fs.readFileSync(stored.path), png);
  assert.equal(fs.statSync(stored.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.record.attachments.directory).mode & 0o777, 0o700);
});

test("bytes that are not a supported raster image are rejected whatever the name claims", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () =>
      f.store.store("session-one", {
        name: "evil.png",
        data: Buffer.from("#!/bin/sh\nrm -rf /\n").toString("base64"),
      }),
    (error) => error.status === 415,
  );
  assert.equal(fs.existsSync(f.record.attachments.directory), false);
});

test("an image beyond the size limit is rejected", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () =>
      f.store.store("session-one", {
        name: "big.png",
        data: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"),
      }),
    (error) => error.status === 413,
  );
});

test("a session without a grant cannot store attachments", async (t) => {
  const f = fixture(t, { attachments: undefined });
  await assert.rejects(
    () => f.store.store("session-one", { name: "a.png", data: png.toString("base64") }),
    (error) => error.status === 409,
  );
});

test("a stopped session cannot store attachments", async (t) => {
  const f = fixture(t, { status: "stopped" });
  await assert.rejects(
    () => f.store.store("session-one", { name: "a.png", data: png.toString("base64") }),
    (error) => error.status === 409,
  );
});

test("a session that reached the storage guard refuses further attachments", async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 64; index++)
    await f.store.store("session-one", { name: "a.png", data: png.toString("base64") });
  await assert.rejects(
    () => f.store.store("session-one", { name: "a.png", data: png.toString("base64") }),
    (error) => error.status === 409,
  );
});

test("mixed image and general file uploads share the grant, quota and serialized cleanup", async (t) => {
  const f = fixture(t);
  const image = await f.store.store("session-one", {
    name: "picture.png",
    data: png.toString("base64"),
  });
  const document = await f.store.save("session-one", "notes.txt", Buffer.from("notes"));
  assert.equal(path.dirname(path.dirname(document.path)), f.record.attachments.directory);
  assert.equal(fs.readFileSync(document.path, "utf8"), "notes");
  for (let index = 0; index < 61; index++)
    await f.store.store("session-one", {
      name: "picture.png",
      data: png.toString("base64"),
    });
  const outcomes = await Promise.allSettled([
    f.store.store("session-one", { name: "picture.png", data: png.toString("base64") }),
    f.store.save("session-one", "extra.txt", Buffer.from("extra")),
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((item) => item.status === "rejected").reason.status, 409);
  await f.store.discard("session-one", f.record.attachments.directory);
  assert.equal(fs.existsSync(image.path), false);
  assert.equal(fs.existsSync(document.path), false);
});
