import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { withoutPromptImagePaths } from "../../server/features/assistants/runtimes/openclaw/prompt-image-paths.js";

// OpenClaw 2026.10.9 (dist/images-*.mjs detectImageReferences): the local image
// references it finds in a turn's text and loads into the model's input.
const ext = "png|jpg|jpeg|gif|webp|bmp|tiff|tif|heic|heif";
const patterns = [
  new RegExp(`file://[^\\s<>"'\`\\]]+\\.(?:${ext})`, "gi"),
  new RegExp(`(?:^|\\s|["'\`(])([A-Za-z]:[\\\\/][^\\s"'\`()\\[\\]]*\\.(?:${ext}))`, "gi"),
  new RegExp(`(?:^|\\s|["'\`(])((\\.\\.?/|[~/])[^\\s"'\`()\\[\\]]*\\.(?:${ext}))`, "gi"),
];
const detected = (text) => patterns.flatMap((p) => [...text.matchAll(p)]);

test("no local image path OpenClaw would load survives", () => {
  for (const text of [
    "see ./attachments/20261109-171204-b20e01db-photo.png please",
    "./media/inbound/openclaw-staged-1/input-a.PNG",
    "(/w/agent/attachments/x.jpg) and '../x.webp' and \"~/y.gif\"",
    "C:\\Users\\x.png and d:/y.tif",
    "file:///w/agent/attachments/x.png",
    "FILE://localhost/w/x.heic",
    "a ./x.png ./y.png\n/z.jpeg",
    "`./x.png`/y.png",
  ]) {
    assert.ok(detected(text).length, text);
    const safe = withoutPromptImagePaths(text);
    assert.deepEqual(detected(safe), [], safe);
    // Only invisible word joiners were added.
    assert.equal(safe.replaceAll("\u2060", ""), text);
  }
  // Text without such a path stays as it is.
  for (const text of ["attachments/x.png", "Plan dinner", "x.png", "http://a/b.png"])
    assert.equal(withoutPromptImagePaths(text), text);
});

test("any text keeps no loadable image path", () => {
  const piece = fc.constantFrom(
    "./",
    "../",
    "/",
    "~",
    "file://",
    "C:\\",
    "d:/",
    " ",
    "\n",
    "'",
    '"',
    "`",
    "(",
    ")",
    "[",
    "]",
    "a",
    "media",
    "inbound",
    ".png",
    ".JPG",
    ".heif",
    "/x",
    "\u2060",
  );
  fc.assert(
    fc.property(fc.array(piece, { maxLength: 30 }), (parts) => {
      const text = parts.join("");
      const safe = withoutPromptImagePaths(text);
      assert.deepEqual(detected(safe), []);
      assert.equal(safe.replaceAll("\u2060", ""), text.replaceAll("\u2060", ""));
    }),
    { numRuns: 2000 },
  );
});
