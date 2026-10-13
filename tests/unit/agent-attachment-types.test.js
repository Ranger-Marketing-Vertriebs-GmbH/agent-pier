import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentNote,
  detectAttachment,
  safeFileName,
} from "../../server/features/assistants/agent-attachment-types.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const gif = Buffer.concat([
  Buffer.from("GIF89a"),
  Buffer.from([1, 0, 1, 0]),
  Buffer.alloc(8),
]);
const webp = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WEBPVP8 "),
  Buffer.alloc(8),
]);
const heic = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypheic"),
  Buffer.alloc(4),
  Buffer.from("mif1heic"),
]);
const pdf = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n", "latin1");

test("detects images, PDF and text by their bytes, not by their names", () => {
  assert.deepEqual(detectAttachment(png, "x.png"), { type: "image/png", kind: "image" });
  assert.deepEqual(detectAttachment(jpeg, "x.txt"), {
    type: "image/jpeg",
    kind: "image",
  });
  assert.deepEqual(detectAttachment(gif, "x"), { type: "image/gif", kind: "image" });
  assert.deepEqual(detectAttachment(webp, "x.webp"), {
    type: "image/webp",
    kind: "image",
  });
  assert.deepEqual(detectAttachment(heic, "IMG_1.HEIC"), {
    type: "image/heic",
    kind: "image",
  });
  assert.deepEqual(detectAttachment(pdf, "report"), {
    type: "application/pdf",
    kind: "document",
  });
  for (const name of ["notes.md", "app.log", "data.json", "a.yaml", "b.csv", "x.conf"])
    assert.deepEqual(detectAttachment(Buffer.from("hello: world\n"), name), {
      type: "text/plain",
      kind: "text",
    });
  // Text needs a known text extension and clean UTF-8 without NUL bytes.
  assert.equal(detectAttachment(Buffer.from("hello"), "tool.exe"), null);
  assert.equal(detectAttachment(Buffer.from("hello"), "noextension"), null);
  assert.equal(detectAttachment(Buffer.from([0x68, 0, 0x69]), "a.txt"), null);
  assert.equal(detectAttachment(Buffer.from([0xc3, 0x28]), "a.txt"), null);
  // A renamed binary is not text and a fake image header is not an image.
  assert.equal(detectAttachment(Buffer.from("MZ\x90\x00", "latin1"), "photo.png"), null);
  assert.equal(detectAttachment(Buffer.from("<svg></svg>"), "x.svg"), null);
  assert.equal(detectAttachment(Buffer.alloc(0), "a.txt"), null);
});

test("file names lose paths, control characters and reserved characters", () => {
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("C:\\Users\\me\\photo.jpg"), "photo.jpg");
  assert.equal(safeFileName("a\u0000b\nc.txt"), "abc.txt");
  assert.equal(safeFileName("  ..hidden .md "), "hidden .md");
  assert.equal(safeFileName('we<i>rd:"na|me?*.txt'), "we_i_rd__na_me__.txt");
  assert.equal(safeFileName(""), "file");
  assert.equal(safeFileName(".."), "file");
  assert.equal(safeFileName(42), "file");
  assert.ok(safeFileName(`${"x".repeat(300)}.pdf`).length <= 100);
  assert.ok(safeFileName(`${"x".repeat(300)}.pdf`).endsWith(".pdf"));
  fc.assert(
    fc.property(fc.string({ maxLength: 400 }), (name) => {
      const safe = safeFileName(name);
      assert.ok(safe.length >= 1 && safe.length <= 100);
      assert.doesNotMatch(safe, /[/\\\x00-\x1f\x7f<>:"|?*]/);
      assert.notEqual(safe[0], ".");
      assert.notEqual(safe, "..");
    }),
  );
});

test("limits and the agent note are stable", () => {
  assert.equal(MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_ATTACHMENTS_PER_MESSAGE, 5);
  const note = attachmentNote([
    { path: "attachments/a-photo.jpg", type: "image/jpeg", size: 1536 },
    { path: "attachments/b-report.pdf", type: "application/pdf", size: 3 * 1048576 },
  ]);
  assert.equal(
    note,
    "[Attached files, saved in your workspace]\n" +
      "- attachments/a-photo.jpg (image/jpeg, 1.5 KB)\n" +
      "- attachments/b-report.pdf (application/pdf, 3.0 MB)",
  );
  assert.equal(attachmentNote([]), "");
});
