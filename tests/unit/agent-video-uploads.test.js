import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AgentAttachments } from "../../server/features/assistants/agent-attachments.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { NOTE_HEADER } from "../../server/features/assistants/agent-attachment-types.js";
import { VIDEO_NOTE } from "../../server/features/assistants/agent-video-types.js";
import { box, mp4File } from "../helpers/video-fixtures.js";

function setup(t, { hooks } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-videos-"));
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
  return { attachments, agent, videos: attachments.videos };
}

const iphone = mp4File({
  brand: "qt  ",
  compatible: ["qt  "],
  rotate: true,
  duration: 600 * 42,
  payload: 3000,
});
async function* once(bytes) {
  yield bytes;
}
// Uploads `bytes` in `parts` chunks the way the composer does.
async function upload(videos, conversationId, bytes, name = "IMG_0042.MOV", parts = 3) {
  const step = Math.ceil(bytes.length / parts);
  const { upload: id } = await videos.begin(
    conversationId,
    name,
    bytes.length,
    bytes.subarray(0, 4096),
  );
  let state;
  for (let offset = 0; offset < bytes.length; offset += step)
    state = await videos.receive(
      conversationId,
      id,
      offset,
      once(bytes.subarray(offset, offset + step)),
    );
  assert.equal(state.complete, true);
  return videos.finish(conversationId, id);
}

test("an iPhone video arrives in chunks and reaches the agent as a described file", async (t) => {
  const { attachments, agent, videos } = setup(t);
  const { a, c, folder } = agent("lead");
  const file = await upload(videos, c.id, iphone);
  assert.deepEqual(file, {
    id: file.id,
    name: "IMG_0042.MOV",
    type: "video/quicktime",
    kind: "video",
    size: iphone.length,
    video: { duration: 42, width: 1080, height: 1920 },
  });
  const [saved] = fs.readdirSync(folder);
  assert.match(saved, /^\d{8}-\d{6}-[0-9a-f]{8}-IMG_0042\.MOV$/);
  assert.deepEqual(fs.readFileSync(path.join(folder, saved)), iphone);
  assert.equal(fs.statSync(path.join(folder, saved)).mode & 0o777, 0o600);

  attachments.claim(c.id, [file.id], "r1");
  const delivery = await attachments.delivery({ id: "r1", text: "What is this?" }, a.id);
  const lines = delivery.message.split("\n");
  assert.equal(lines[2], NOTE_HEADER);
  assert.match(
    lines[3],
    /^- "attachments\/[^"]+-IMG_0042\.MOV" \(video\/quicktime, \d\.\d KB, 0:42, 1080x1920\)$/,
  );
  assert.equal(lines[4], VIDEO_NOTE);
  // No model receives a video inline.
  assert.equal(delivery.attachments, undefined);
  const history = attachments.forConversation(c.id).get("r1");
  assert.equal(history.note, lines.slice(2).join("\n"));
  assert.deepEqual(history.files, [file]);
});

test("a chunk continues only where the copy ends, and limits hold", async (t) => {
  const { agent, videos } = setup(t);
  const { c, folder } = agent("lead");
  const { upload: id } = await videos.begin(c.id, "clip.mp4", 5000, mp4File());
  await videos.receive(c.id, id, 0, once(Buffer.alloc(100)));
  await assert.rejects(videos.receive(c.id, id, 0, once(Buffer.alloc(10))), {
    status: 409,
    key: "videoUploadOffset",
    received: 100,
  });
  await assert.rejects(videos.finish(c.id, id), { status: 409 });
  // More than announced: the upload is given up and its copy removed.
  await assert.rejects(videos.receive(c.id, id, 100, once(Buffer.alloc(4901))), {
    status: 413,
    key: "videoTooLarge",
  });
  assert.deepEqual(fs.readdirSync(folder), []);
  await assert.rejects(videos.receive(c.id, id, 100, once(Buffer.alloc(1))), {
    status: 404,
  });
  await assert.rejects(videos.begin(c.id, "big.mp4", 200 * 1024 * 1024 + 1, mp4File()), {
    status: 413,
    key: "videoTooLarge",
  });
  await assert.rejects(videos.begin(c.id, "x.mp4", 0, mp4File()), { status: 400 });
  // A PNG or an HEIC photo is no video, whatever its name.
  const heic = box("ftyp", Buffer.from("heic"), Buffer.alloc(4), Buffer.from("mif1heic"));
  await assert.rejects(videos.begin(c.id, "x.mov", 100, heic), {
    status: 415,
    key: "attachmentUnsupported",
  });
  // Another conversation cannot continue or cancel the upload.
  const other = agent("other");
  const { upload: mine } = await videos.begin(c.id, "clip.mp4", 5000, mp4File());
  await assert.rejects(videos.receive(other.c.id, mine, 0, once(Buffer.alloc(1))), {
    status: 404,
  });
  await assert.rejects(videos.cancel(other.c.id, mine), { status: 404 });
  await videos.cancel(c.id, mine);
  assert.deepEqual(fs.readdirSync(folder), []);
});

test("a container without its movie box is refused once complete", async (t) => {
  const { agent, videos, attachments } = setup(t);
  const { c, folder } = agent("lead");
  const ftyp = box("ftyp", Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isom"));
  const fake = Buffer.concat([ftyp, box("mdat", Buffer.alloc(500))]);
  await assert.rejects(upload(videos, c.id, fake, "fake.mp4"), {
    status: 415,
    key: "attachmentUnsupported",
  });
  assert.deepEqual(fs.readdirSync(folder), []);
  assert.equal(attachments.staged(c.id, [], false).length, 0);
});

test("videos still arriving count against the agent's quota", async (t) => {
  const { agent, videos } = setup(t);
  const { c, folder } = agent("lead");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  // A sparse file the agent left: nearly 1 GiB, no disk space used.
  const filler = path.join(folder, "agent-notes.bin");
  fs.writeFileSync(filler, "");
  fs.truncateSync(filler, 1024 * 1024 * 1024 - 300 * 1024 * 1024);
  const mb = 1024 * 1024;
  await videos.begin(c.id, "a.mp4", 150 * mb, mp4File());
  await assert.rejects(videos.begin(c.id, "b.mp4", 160 * mb, mp4File()), {
    status: 409,
    key: "attachmentStorageFull",
  });
  await videos.begin(c.id, "c.mp4", 140 * mb, mp4File());
});

test("an agent keeps three uploads open; only idle ones give way", async (t) => {
  const { agent, videos } = setup(t);
  const { c, folder } = agent("lead");
  const ids = [];
  for (let n = 0; n < 3; n++)
    ids.push((await videos.begin(c.id, `v${n}.mp4`, 9000, mp4File())).upload);
  // Three uploads still moving: a fourth is refused, none is dropped.
  await assert.rejects(videos.begin(c.id, "v3.mp4", 9000, mp4File()), {
    status: 429,
    key: "videoUploadsBusy",
  });
  assert.equal(fs.readdirSync(folder).length, 3);
  // One left behind by a closed page makes room.
  videos.uploads.get(ids[0]).touched = Date.now() - 3 * 60 * 1000;
  const fourth = (await videos.begin(c.id, "v3.mp4", 9000, mp4File())).upload;
  assert.equal(fs.readdirSync(folder).length, 3);
  await assert.rejects(videos.receive(c.id, ids[0], 0, once(Buffer.alloc(1))), {
    status: 404,
  });
  await videos.receive(c.id, fourth, 0, once(Buffer.alloc(1)));
});

test("a resent first or last chunk continues the upload or names the staged file", async (t) => {
  const { agent, videos } = setup(t);
  const { c } = agent("lead");
  const id = "0b6c1f0e-3a1d-4f6e-9a6b-2c1d3e4f5a6b";
  const head = iphone.subarray(0, 4096);
  assert.deepEqual(await videos.begin(c.id, "a.mov", iphone.length, head, id), {
    upload: id,
    received: 0,
  });
  await videos.receive(c.id, id, 0, once(iphone.subarray(0, 1000)));
  // The first reply was lost: the same POST learns where the copy ends.
  assert.deepEqual(await videos.begin(c.id, "a.mov", iphone.length, head, id), {
    upload: id,
    received: 1000,
  });
  await assert.rejects(videos.begin(agent("other").c.id, "a.mov", 10, head, id), {
    status: 409,
  });
  await assert.rejects(videos.begin(c.id, "a.mov", 10, head, "not-an-id"), {
    status: 400,
  });
  await videos.receive(c.id, id, 1000, once(iphone.subarray(1000)));
  const file = await videos.finish(c.id, id);
  // The last reply was lost: the retried chunk, or the first one, names the file.
  assert.deepEqual(await videos.receive(c.id, id, 1000, once(Buffer.alloc(0))), {
    complete: true,
    file,
  });
  assert.deepEqual(await videos.begin(c.id, "a.mov", iphone.length, head, id), { file });
});

test("leftovers of a restart are swept; agent files and fresh copies stay", async (t) => {
  const { agent, videos, attachments } = setup(t);
  const { a, c, folder } = agent("lead");
  const kept = await upload(videos, c.id, iphone);
  const [indexed] = fs.readdirSync(folder);
  const old = (Date.now() - 11 * 60 * 1000) / 1000;
  const write = (name, time = old) => {
    fs.writeFileSync(path.join(folder, name), "partial");
    fs.utimesSync(path.join(folder, name), time, time);
  };
  write("20261018-010203-0a1b2c3d-IMG_0001.MOV");
  write("20261018-010203-0a1b2c3e-fresh.MOV", Date.now() / 1000);
  write("agent-notes.md");
  fs.utimesSync(path.join(folder, indexed), old, old);
  // An upload still arriving is never swept, however old its copy looks.
  const { upload: open } = await videos.begin(c.id, "open.mov", 9000, mp4File());
  const arriving = videos.uploads.get(open).file;
  fs.utimesSync(path.join(folder, arriving), old, old);
  await attachments.stage(c.id, "notes.md", Buffer.from("# Notes\n"));
  const names = fs.readdirSync(folder);
  assert.equal(names.includes("20261018-010203-0a1b2c3d-IMG_0001.MOV"), false);
  for (const name of [
    "20261018-010203-0a1b2c3e-fresh.MOV",
    "agent-notes.md",
    indexed,
    arriving,
  ])
    assert.ok(names.includes(name), name);
  // At startup, before anything is staged.
  write("20261018-010203-0a1b2c3f-IMG_0002.MOV");
  await videos.sweepAll();
  assert.equal(
    fs.existsSync(path.join(folder, "20261018-010203-0a1b2c3f-IMG_0002.MOV")),
    false,
  );
  assert.ok(kept && a);
});

test("maintenance drops open uploads with their partial copies", async (t) => {
  const { agent, videos } = setup(t);
  const { c, folder } = agent("lead");
  const { upload: id } = await videos.begin(c.id, "clip.mp4", 9000, mp4File());
  await videos.receive(c.id, id, 0, once(Buffer.alloc(100)));
  await videos.dropAll();
  assert.deepEqual(fs.readdirSync(folder), []);
  await assert.rejects(videos.receive(c.id, id, 100, once(Buffer.alloc(1))), {
    status: 404,
  });
});

test("a finished video makes room among unsent files like any upload", async (t) => {
  const { agent, videos, attachments } = setup(t);
  const { c } = agent("lead");
  const first = await attachments.stage(c.id, "first.md", Buffer.from("x"));
  for (let n = 0; n < 19; n++)
    await attachments.stage(c.id, `n${n}.md`, Buffer.from("x"));
  const video = await upload(videos, c.id, iphone);
  const staged = attachments.staged(c.id, [first.id, video.id], false);
  assert.deepEqual(
    staged.map((f) => f.id),
    [video.id],
  );
});

test("a video folder swapped for a link during the start receives nothing", async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-videos-swap-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  let swap = false;
  const { agent, videos } = setup(t, {
    hooks: {
      checked: (folder) => {
        if (!swap) return;
        fs.renameSync(folder.path, `${folder.path}-moved`);
        fs.symlinkSync(outside, folder.path);
      },
    },
  });
  const { c } = agent("lead");
  swap = true;
  await assert.rejects(videos.begin(c.id, "clip.mov", iphone.length, iphone), {
    status: 409,
    key: "attachmentStorageUnsafe",
  });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("a video is served only while its bytes are the ones uploaded", async (t) => {
  const { agent, videos, attachments } = setup(t);
  const { a, c, folder } = agent("lead");
  const file = await upload(videos, c.id, iphone);
  const served = await attachments.serve(file.id);
  assert.equal(served.type, "video/quicktime");
  assert.equal(served.size, iphone.length);
  const head = Buffer.alloc(8);
  await served.handle.read(head, 0, 8, 0);
  await served.handle.close();
  assert.deepEqual(head, iphone.subarray(0, 8));
  // The agent rewrites the copy in place, same size.
  const [saved] = fs.readdirSync(folder);
  const tampered = Buffer.from(iphone);
  tampered[tampered.length - 1] ^= 1;
  fs.writeFileSync(path.join(folder, saved), tampered, { flag: "r+" });
  await assert.rejects(attachments.serve(file.id), { status: 404 });
  // A hard link would expose the bytes elsewhere.
  fs.writeFileSync(path.join(folder, saved), iphone, { flag: "r+" });
  fs.linkSync(path.join(folder, saved), path.join(folder, "copy.mov"));
  await assert.rejects(attachments.serve(file.id), { status: 404 });
  assert.ok(a.id);
});
