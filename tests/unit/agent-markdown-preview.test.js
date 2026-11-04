import test from "node:test";
import assert from "node:assert/strict";
import {
  MARKDOWN_PREVIEW_MAX_BYTES,
  isMarkdownAttachment,
  markdownTooLarge,
  readMarkdown,
} from "../../web/features/assistants/agent-markdown-preview.js";

const file = (name, extra = {}) => ({
  id: "a",
  name,
  type: "text/plain",
  kind: "text",
  size: 10,
  ...extra,
});

test("Markdown files are recognised by their name or type", () => {
  assert.equal(isMarkdownAttachment(file("notes.md")), true);
  assert.equal(isMarkdownAttachment(file("README.MD")), true);
  assert.equal(isMarkdownAttachment(file("plan.markdown")), true);
  assert.equal(
    isMarkdownAttachment(file("report", { type: "text/markdown; charset=utf-8" })),
    true,
  );
  // A file an agent shared that the server could not read as text keeps its name.
  assert.equal(
    isMarkdownAttachment(
      file("notes.md", { type: "application/octet-stream", kind: "file" }),
    ),
    true,
  );
  for (const name of ["notes.txt", "notes.md.pdf", "md", "notes.mdx", ""])
    assert.equal(isMarkdownAttachment(file(name)), false, name);
});

test("media, missing and unavailable files never open as Markdown", () => {
  assert.equal(isMarkdownAttachment(null), false);
  assert.equal(isMarkdownAttachment(file("a.md", { unavailable: true })), false);
  for (const kind of ["image", "video", "audio"])
    assert.equal(isMarkdownAttachment(file("a.md", { kind })), false, kind);
});

test("the preview cap is 512 KiB of recorded size", () => {
  assert.equal(MARKDOWN_PREVIEW_MAX_BYTES, 512 * 1024);
  assert.equal(
    markdownTooLarge(file("a.md", { size: MARKDOWN_PREVIEW_MAX_BYTES })),
    false,
  );
  assert.equal(
    markdownTooLarge(file("a.md", { size: MARKDOWN_PREVIEW_MAX_BYTES + 1 })),
    true,
  );
  // An unknown size is read with the cap instead.
  assert.equal(markdownTooLarge(file("a.md", { size: undefined })), false);
});

const response = (chunks, headers = {}) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { headers },
  );

test("the text is read as UTF-8 up to the cap", async () => {
  // A multi-byte character split across chunks still decodes.
  const bytes = new TextEncoder().encode("# Über");
  const split = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 3));
        controller.enqueue(bytes.slice(3));
        controller.close();
      },
    }),
  );
  assert.deepEqual(await readMarkdown(split), { text: "# Über" });
  assert.deepEqual(await readMarkdown(response(["abc", "def"]), 6), { text: "abcdef" });
});

test("a body over the cap stops reading and reports it too large", async () => {
  assert.deepEqual(await readMarkdown(response(["abc", "defg"]), 6), { tooLarge: true });
  assert.deepEqual(await readMarkdown(response(["a"], { "content-length": "7" }), 6), {
    tooLarge: true,
  });
});
