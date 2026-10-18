import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  MAX_VIDEO_BYTES,
  bufferReader,
  formatDuration,
  videoMetadata,
  videoType,
} from "../../server/features/assistants/agent-video-types.js";
import {
  attachmentNote,
  detectAttachment,
} from "../../server/features/assistants/agent-attachment-types.js";
import { box, mp4File, webmFile } from "../helpers/video-fixtures.js";

const metadata = (type, bytes) => videoMetadata(type, bufferReader(bytes), bytes.length);

test("videos are recognised by their container bytes, iPhone MOV included", () => {
  // An iPhone recording: QuickTime brand, HEVC or H.264 inside.
  assert.equal(
    videoType(mp4File({ brand: "qt  ", compatible: ["qt  "] })),
    "video/quicktime",
  );
  assert.equal(videoType(mp4File({ brand: "isom" })), "video/mp4");
  assert.equal(
    videoType(mp4File({ brand: "mp42", compatible: ["mp42", "mp41"] })),
    "video/mp4",
  );
  // An M4V export from Photos, and a file that names QuickTime only as compatible.
  assert.equal(
    videoType(mp4File({ brand: "M4V ", compatible: ["M4V ", "mp42"] })),
    "video/mp4",
  );
  assert.equal(
    videoType(mp4File({ brand: "XAVC", compatible: ["qt  "] })),
    "video/quicktime",
  );
  assert.equal(videoType(webmFile()), "video/webm");
});

test("HEIC photos, Matroska, other boxes and junk are no videos", () => {
  const heic = Buffer.concat([
    box("ftyp", Buffer.from("heic"), Buffer.alloc(4), Buffer.from("mif1heic")),
  ]);
  assert.equal(videoType(heic), null);
  // An HEIF image sequence that also lists an MP4 brand stays an image.
  const sequence = box(
    "ftyp",
    Buffer.from("msf1"),
    Buffer.alloc(4),
    Buffer.from("iso8msf1"),
  );
  assert.equal(videoType(sequence), null);
  assert.equal(videoType(webmFile({ docType: "matroska" })), null);
  assert.equal(videoType(box("ftyp", Buffer.from("crx "), Buffer.alloc(4))), null);
  assert.equal(videoType(Buffer.from("not a video at all")), null);
  assert.equal(videoType(Buffer.alloc(0)), null);
  // The buffer path for owner files and shared files never takes a video.
  assert.equal(detectAttachment(mp4File(), "clip.mp4"), null);
  assert.equal(detectAttachment(webmFile(), "clip.webm"), null);
});

test("reads duration and size from the movie box, before or after the media", async () => {
  for (const moovFirst of [false, true])
    for (const version of [0, 1])
      assert.deepEqual(await metadata("video/mp4", mp4File({ moovFirst, version })), {
        duration: 42,
        width: 1920,
        height: 1080,
      });
  // iPhone portrait: stored landscape, turned by the track matrix.
  assert.deepEqual(
    await metadata(
      "video/quicktime",
      mp4File({
        brand: "qt  ",
        compatible: ["qt  "],
        rotate: true,
        duration: 600 * 3 + 30,
      }),
    ),
    { duration: 3.1, width: 1080, height: 1920 },
  );
});

test("a movie without a movie box or with broken boxes is refused", async () => {
  const ftyp = box("ftyp", Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isom"));
  assert.equal(
    await metadata("video/mp4", Buffer.concat([ftyp, box("mdat", Buffer.alloc(9))])),
    null,
  );
  const broken = Buffer.concat([ftyp, Buffer.from([0, 0, 0, 3]), Buffer.from("free")]);
  assert.equal(await metadata("video/mp4", broken), null);
  // A box that claims more than the file holds ends the walk.
  const cut = mp4File();
  assert.equal(await metadata("video/mp4", cut.subarray(0, cut.length - 40)), null);
});

test("reads WebM duration and the video track's pixels", async () => {
  assert.deepEqual(await metadata("video/webm", webmFile()), {
    duration: 2.5,
    width: 640,
    height: 360,
  });
  // A live recording has no duration and may leave the segment size open.
  assert.deepEqual(
    await metadata("video/webm", webmFile({ duration: null, unknownSegmentSize: true })),
    { width: 640, height: 360 },
  );
  assert.equal(await metadata("video/webm", webmFile({ docType: "matroska" })), null);
});

test("metadata parsing never throws on random bytes", async () => {
  await fc.assert(
    fc.asyncProperty(fc.uint8Array({ maxLength: 400 }), async (bytes) => {
      const head = Buffer.concat([mp4File().subarray(0, 24), Buffer.from(bytes)]);
      await metadata("video/mp4", head);
      await metadata(
        "video/webm",
        Buffer.concat([webmFile().subarray(0, 30), Buffer.from(bytes)]),
      );
    }),
    { numRuns: 300 },
  );
});

test("the agent learns that a video is a file it cannot watch", () => {
  assert.equal(MAX_VIDEO_BYTES, 200 * 1024 * 1024);
  assert.equal(formatDuration(42), "0:42");
  assert.equal(formatDuration(3723.4), "1:02:03");
  const note = attachmentNote([
    { path: "attachments/a.png", type: "image/png", size: 2048 },
    {
      path: "attachments/clip.mov",
      type: "video/quicktime",
      size: 12 * 1024 * 1024,
      video: { duration: 42, width: 1080, height: 1920 },
    },
  ]);
  const lines = note.split("\n");
  assert.equal(lines[1], '- "attachments/a.png" (image/png, 2.0 KB)');
  assert.equal(
    lines[2],
    '- "attachments/clip.mov" (video/quicktime, 12.0 MB, 0:42, 1080x1920)',
  );
  assert.match(lines[3], /cannot watch/);
  // Notes without videos stay exactly as before, so older history still matches.
  assert.equal(
    attachmentNote([{ path: "attachments/a.png", type: "image/png", size: 2048 }]).split(
      "\n",
    ).length,
    2,
  );
});
