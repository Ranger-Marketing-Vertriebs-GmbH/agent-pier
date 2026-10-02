import test from "node:test";
import assert from "node:assert/strict";
import { extractToolImages } from "../../server/features/chat/tool-images.js";

test("claude and mcp image payloads become numbered placeholders", () => {
  const images = [];
  const value = [
    { type: "text", text: "kept" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    { type: "image", mimeType: "image/webp", data: "BBBB" },
  ];
  const copy = extractToolImages(value, images);
  assert.deepEqual(copy, [{ type: "text", text: "kept" }, "[image 1]", "[image 2]"]);
  assert.deepEqual(images, [
    { mime: "image/png", data: "AAAA" },
    { mime: "image/webp", data: "BBBB" },
  ]);
  assert.equal(value[1].source.data, "AAAA", "input not mutated");
});

test("numbering continues across calls sharing one array", () => {
  const images = [{ mime: "image/png", data: "X" }];
  assert.equal(
    extractToolImages(
      { type: "image", source: { media_type: "image/jpeg", data: "Y" } },
      images,
    ),
    "[image 2]",
  );
});

test("unsupported types, strings and plain json are unchanged", () => {
  const images = [];
  const value = {
    a: "data:image/png;base64,AAAA",
    b: { type: "image", mimeType: "image/svg+xml", data: "S" },
    n: 1,
  };
  assert.deepEqual(extractToolImages(value, images), value);
  assert.deepEqual(images, []);
  assert.equal(extractToolImages("plain", images), "plain");
  assert.equal(extractToolImages(null, images), null);
});
