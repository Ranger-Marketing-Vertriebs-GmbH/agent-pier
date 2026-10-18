import test from "node:test";
import assert from "node:assert/strict";
import {
  VIDEO_CHUNK_BYTES,
  VIDEO_STALL_MS,
  uploadVideo,
} from "../../web/features/assistants/agent-video-upload.js";

const MiB = 1024 * 1024;
const id = "0b6c1f0e-3a1d-4f6e-9a6b-2c1d3e4f5a6b";
const video = (size) => new File([new Uint8Array(size)], "IMG_0042.MOV");

// A scripted server: each call answers with the next reply; calls are recorded.
function transport(replies) {
  const calls = [];
  const removed = [];
  return {
    calls,
    removed,
    deps: {
      id,
      pause: async () => {},
      remove: async (path, method) => removed.push([method, path]),
      send: async (method, url, body, signal, progress, stallMs) => {
        calls.push({ method, url: new URL(url, "http://x"), size: body.size, stallMs });
        progress(body.size);
        const reply = replies.shift();
        return typeof reply === "function" ? reply() : reply;
      },
    },
  };
}
const file = (size) => ({
  status: 201,
  result: { id: "video-1", name: "IMG_0042.MOV", kind: "video", size },
});

test("the client names the upload and resends a first chunk that got no answer", async () => {
  const size = VIDEO_CHUNK_BYTES + 100;
  const t = transport([
    { status: 0, result: {} },
    { status: 201, result: { upload: id, received: VIDEO_CHUNK_BYTES } },
    file(size),
  ]);
  const seen = [];
  const result = await uploadVideo(
    "c1",
    video(size),
    new AbortController().signal,
    (p) => seen.push(p),
    t.deps,
  );
  assert.equal(result.id, "video-1");
  assert.deepEqual(
    t.calls.map((c) => [
      c.method,
      c.url.searchParams.get("upload") || c.url.searchParams.get("offset"),
    ]),
    [
      ["POST", id],
      ["POST", id],
      ["PUT", String(VIDEO_CHUNK_BYTES)],
    ],
  );
  // No fixed timeout: a chunk gives up only when its progress stalls.
  assert.ok(t.calls.every((c) => c.stallMs === VIDEO_STALL_MS));
  assert.equal(seen.at(-1), 100);
  assert.deepEqual(t.removed, []);
});

test("a lost reply to the last chunk ends with the staged file, not an error", async () => {
  const size = 2 * VIDEO_CHUNK_BYTES;
  const t = transport([
    { status: 201, result: { upload: id, received: VIDEO_CHUNK_BYTES } },
    { status: 0, result: {} },
    // The server finished the video; the retry learns its record.
    file(size),
  ]);
  const result = await uploadVideo(
    "c1",
    video(size),
    new AbortController().signal,
    () => {},
    t.deps,
  );
  assert.equal(result.id, "video-1");
  assert.deepEqual(
    t.calls.map((c) => c.method),
    ["POST", "PUT", "PUT"],
  );
});

test("a slow line that keeps moving never runs out of retries", async () => {
  const size = 5 * MiB;
  const replies = [{ status: 201, result: { upload: id, received: 1 * MiB } }];
  // Every chunk is cut off, but the server got a little more each time.
  for (let n = 2; n <= 4; n++)
    replies.push(
      { status: 0, result: {} },
      { status: 409, result: { received: n * MiB } },
    );
  replies.push(file(size));
  const t = transport(replies);
  const result = await uploadVideo(
    "c1",
    video(size),
    new AbortController().signal,
    () => {},
    t.deps,
  );
  assert.equal(result.id, "video-1");
  assert.equal(t.calls.at(-1).url.searchParams.get("offset"), String(4 * MiB));
});

test("a broken line gives up after three tries and discards the upload", async () => {
  const t = transport([
    { status: 201, result: { upload: id, received: 1 * MiB } },
    ...Array(4).fill({ status: 0, result: {} }),
  ]);
  await assert.rejects(
    uploadVideo(
      "c1",
      video(VIDEO_CHUNK_BYTES * 2),
      new AbortController().signal,
      () => {},
      t.deps,
    ),
  );
  assert.equal(t.calls.length, 5);
  assert.deepEqual(t.removed, [
    ["DELETE", `/assistant-conversations/c1/video-uploads/${id}`],
  ]);
});
