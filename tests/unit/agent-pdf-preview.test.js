import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CANVAS_PIXELS,
  PDF_PREVIEW_MAX_BYTES,
  canvasScale,
  isPdfAttachment,
  pdfTooLarge,
  readPdf,
} from "../../web/features/assistants/agent-pdf-preview.js";

const file = (name, extra = {}) => ({
  id: "a",
  name,
  type: "application/pdf",
  kind: "file",
  size: 10,
  ...extra,
});

test("PDF files are recognised by their type or name", () => {
  assert.equal(isPdfAttachment(file("report.pdf")), true);
  assert.equal(
    isPdfAttachment(file("REPORT.PDF", { type: "application/octet-stream" })),
    true,
  );
  assert.equal(
    isPdfAttachment(file("x", { type: "application/pdf; charset=binary" })),
    true,
  );
  assert.equal(isPdfAttachment(file("notes.md", { type: "text/plain" })), false);
  assert.equal(isPdfAttachment(null), false);
});

test("unavailable and media files never open as PDF", () => {
  assert.equal(isPdfAttachment({ unavailable: true, name: "a.pdf" }), false);
  assert.equal(isPdfAttachment({ kind: "image", name: "a.pdf" }), false);
});

test("the preview cap is 10 MiB of recorded size", () => {
  assert.equal(PDF_PREVIEW_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(pdfTooLarge(file("a.pdf", { size: 10 * 1024 * 1024 })), false);
  assert.equal(pdfTooLarge(file("a.pdf", { size: 10 * 1024 * 1024 + 1 })), true);
  assert.equal(pdfTooLarge(file("a.pdf", { size: undefined })), false);
});

const streamed = (chunks, headers = {}) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers },
  );

test("the bytes are read up to the cap", async () => {
  const result = await readPdf(new Response(new Uint8Array([1, 2, 3])));
  assert.equal(result.data.length, 3);
  assert.deepEqual([...result.data], [1, 2, 3]);
  const split = await readPdf(streamed([new Uint8Array([1, 2]), new Uint8Array([3])]));
  assert.deepEqual([...split.data], [1, 2, 3]);
});

test("a body over the cap reports it too large", async () => {
  assert.deepEqual(
    await readPdf(
      new Response(new Uint8Array(1), { headers: { "content-length": "20" } }),
      10,
    ),
    { tooLarge: true },
  );
  assert.deepEqual(await readPdf(streamed([new Uint8Array(6), new Uint8Array(6)]), 10), {
    tooLarge: true,
  });
});

test("the canvas scale keeps the pixel count under the cap", () => {
  assert.equal(canvasScale(612, 792, 1, 2), 2);
  const s = canvasScale(10000, 10000, 3, 3);
  assert.ok(s > 0);
  assert.ok(10000 * 10000 * s * s <= MAX_CANVAS_PIXELS);
});
