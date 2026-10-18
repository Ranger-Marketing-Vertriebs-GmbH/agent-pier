import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AgentAttachments } from "../../server/features/assistants/agent-attachments.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { mp4File } from "../helpers/video-fixtures.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function setup(t, { hooks } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attachment-clear-"));
  const workspaces = path.join(dataDir, "workspaces");
  fs.mkdirSync(workspaces, { mode: 0o700 });
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const connections = {
    get: () => ({
      providerId: "endpoint",
      endpoint: { models: [{ modelId: "vision", images: true }] },
    }),
  };
  const attachments = new AgentAttachments({
    store,
    models: new AssistantModels({ connections }),
    config: { workspaces },
    hooks,
  });
  const agent = (name) => {
    const a = store.createAssistant({
      name,
      instructions: "",
      model: { connectionId: "endpoint", modelId: "vision" },
    });
    const c = store.saveConversation({ assistantId: a.id, runtimeSessionKey: name });
    return { a, c, folder: path.join(workspaces, a.id, "attachments") };
  };
  return { attachments, agent, dataDir, workspaces };
}
const outsideDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attachment-outside-"));
  fs.writeFileSync(path.join(dir, "keep.txt"), "owner data");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("usage counts the folder against its limits and clearing empties it", async (t) => {
  const { attachments, agent } = setup(t);
  const { a, c, folder } = agent("lead");
  const other = agent("other");
  assert.deepEqual(await attachments.usage(a.id), {
    files: 0,
    bytes: 0,
    capped: false,
    maxBytes: 1024 * 1024 * 1024,
    maxFiles: 1000,
  });
  const sent = await attachments.stage(c.id, "photo.png", png);
  attachments.claim(c.id, [sent.id], "r1");
  const staged = await attachments.stage(c.id, "notes.md", Buffer.from("# Notes\n"));
  // The agent's own files count as well.
  fs.writeFileSync(path.join(folder, "agent-made.txt"), "12345");
  fs.mkdirSync(path.join(folder, "agent-dir"));
  const shared = await attachments.share({
    conversation: { id: c.id, assistantId: a.id },
    requestId: "r1",
    name: "report.md",
    body: Buffer.from("report"),
  });
  await attachments.stage(other.c.id, "theirs.png", png);
  const usage = await attachments.usage(a.id);
  assert.equal(usage.files, 4);
  assert.equal(usage.bytes, png.length + 8 + 5);

  assert.deepEqual(await attachments.clear(a.id), {
    files: 4,
    bytes: png.length + 8 + 5,
  });
  assert.equal(fs.existsSync(folder), false);
  assert.equal((await attachments.usage(a.id)).files, 0);
  // The sent file stays in its message, named and unavailable; no unsent one is left.
  const [file] = attachments.forConversation(c.id).get("r1").files;
  assert.deepEqual(file, { ...sent, unavailable: true });
  await assert.rejects(attachments.content(sent.id), { status: 404 });
  await assert.rejects(attachments.discard(c.id, staged.id), { status: 404 });
  // Files the agent shared and other agents' attachments stay.
  assert.deepEqual((await attachments.content(shared.id)).body, Buffer.from("report"));
  assert.equal((await attachments.usage(other.a.id)).files, 1);
  // The next upload recreates the folder.
  const again = await attachments.stage(c.id, "again.png", png);
  assert.deepEqual((await attachments.content(again.id)).body, png);
  assert.equal((await attachments.usage(a.id)).files, 1);
});

test("clearing ends a video still arriving and removes its partial copy", async (t) => {
  const { attachments, agent } = setup(t);
  const { a, c, folder } = agent("lead");
  const video = mp4File({ brand: "qt  ", compatible: ["qt  "], payload: 3000 });
  const { upload } = await attachments.videos.begin(
    c.id,
    "IMG_0001.MOV",
    video.length,
    video.subarray(0, 4096),
  );
  await attachments.videos.receive(
    c.id,
    upload,
    0,
    (async function* () {
      yield video.subarray(0, 1000);
    })(),
  );
  assert.equal(fs.readdirSync(folder).length, 1);
  await attachments.clear(a.id);
  assert.equal(fs.existsSync(folder), false);
  assert.equal(attachments.videos.arriving(a.id).size, 0);
  await assert.rejects(
    attachments.videos.receive(
      c.id,
      upload,
      1000,
      (async function* () {
        yield video.subarray(1000);
      })(),
    ),
    { status: 404 },
  );
});

test("a folder swapped for a link before clearing loses nothing outside (M1)", async (t) => {
  const outside = outsideDir(t);
  let swap = false;
  const { attachments, agent } = setup(t, {
    hooks: {
      clearing: (folder) => {
        if (!swap) return;
        fs.renameSync(folder.path, `${folder.path}-moved`);
        fs.symlinkSync(outside, folder.path);
      },
    },
  });
  const { a, c, folder } = agent("lead");
  await attachments.stage(c.id, "photo.png", png);
  swap = true;
  await assert.rejects(attachments.clear(a.id), {
    status: 409,
    key: "attachmentStorageUnsafe",
  });
  assert.deepEqual(fs.readdirSync(outside), ["keep.txt"]);
  // The link is put back where it was, and the moved folder is untouched.
  assert.equal(fs.lstatSync(folder).isSymbolicLink(), true);
  assert.equal(fs.readdirSync(`${folder}-moved`).length, 1);
});

test("a folder swapped for another directory before clearing is kept (M1)", async (t) => {
  let swap = false;
  const { attachments, agent } = setup(t, {
    hooks: {
      clearing: (folder) => {
        if (!swap) return;
        fs.renameSync(folder.path, `${folder.path}-moved`);
        fs.mkdirSync(folder.path);
        fs.writeFileSync(path.join(folder.path, "agent-notes.md"), "keep");
      },
    },
  });
  const { a, c, folder } = agent("lead");
  await attachments.stage(c.id, "photo.png", png);
  swap = true;
  await assert.rejects(attachments.clear(a.id), { status: 409 });
  assert.deepEqual(fs.readdirSync(folder), ["agent-notes.md"]);
  // The index is untouched as well: nothing was cleared.
  assert.equal((await attachments.usage(a.id)).files, 1);
});

test("a linked attachments folder is never cleared or counted through", async (t) => {
  const outside = outsideDir(t);
  const { attachments, agent } = setup(t);
  const { a, c, folder } = agent("lead");
  await attachments.stage(c.id, "photo.png", png);
  fs.rmSync(folder, { recursive: true });
  fs.symlinkSync(outside, folder);
  await assert.rejects(attachments.usage(a.id), { key: "attachmentStorageUnsafe" });
  await assert.rejects(attachments.clear(a.id), { key: "attachmentStorageUnsafe" });
  assert.deepEqual(fs.readdirSync(outside), ["keep.txt"]);
});

test("links inside the folder are removed, never followed", async (t) => {
  const outside = outsideDir(t);
  const { attachments, agent } = setup(t);
  const { a, c, folder } = agent("lead");
  await attachments.stage(c.id, "photo.png", png);
  fs.symlinkSync(outside, path.join(folder, "dir-link"));
  fs.symlinkSync(path.join(outside, "keep.txt"), path.join(folder, "file-link"));
  await attachments.clear(a.id);
  assert.equal(fs.existsSync(folder), false);
  assert.deepEqual(fs.readdirSync(outside), ["keep.txt"]);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "owner data");
});

test("purge removes both folders only as checked (M1)", async (t) => {
  const outside = outsideDir(t);
  let swap = false;
  const { attachments, agent, dataDir } = setup(t, {
    hooks: {
      clearing: (folder) => {
        if (!swap) return;
        fs.renameSync(folder.path, `${folder.path}-moved`);
        fs.symlinkSync(outside, folder.path);
      },
    },
  });
  const { a, c, folder } = agent("lead");
  await attachments.stage(c.id, "photo.png", png);
  await attachments.share({
    conversation: { id: c.id, assistantId: a.id },
    requestId: "r1",
    name: "report.md",
    body: Buffer.from("report"),
  });
  swap = true;
  await assert.rejects(attachments.purge(a.id), { status: 409 });
  assert.deepEqual(fs.readdirSync(outside), ["keep.txt"]);
  swap = false;
  fs.rmSync(folder);
  fs.renameSync(`${folder}-moved`, folder);
  await attachments.purge(a.id);
  assert.equal(fs.existsSync(folder), false);
  assert.equal(fs.existsSync(path.join(dataDir, "shares", a.id)), false);
  // Nothing is left behind in the private trash.
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "attachment-trash")), []);
});

test("unknown agents have no usage and nothing to clear", async (t) => {
  const { attachments } = setup(t);
  await assert.rejects(attachments.usage("missing"), { status: 404 });
  await assert.rejects(attachments.clear("missing"), { status: 404 });
});

test("the audit keeps how many entries and bytes a clear removed", () => {
  const event = auditEvent({
    action: "assistant.updated",
    resourceType: "assistant",
    resourceId: "agent-1",
    source: "user",
    outcome: "success",
    details: { kind: "attachment-clear", count: 3, bytes: 1024, name: "secret.png" },
  });
  assert.deepEqual(event.details, { kind: "attachment-clear", count: 3, bytes: 1024 });
});
