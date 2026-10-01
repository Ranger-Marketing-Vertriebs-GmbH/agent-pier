import test from "node:test";
import assert from "node:assert/strict";
import { codexImageInput } from "../../server/features/chat/codex-image-input.js";

const image = { type: "image", image_url: "data:image/png;base64,AQID" };
const text = {
  type: "text",
  text: "[Image #1] Inspect 🐈 and literal [Image #2]",
  text_elements: [{ byte_range: { start: 0, end: 10 }, placeholder: "[Image #1]" }],
};
test("only explicit image chips and embedded image bytes provide native input evidence", () => {
  assert.equal(
    codexImageInput([image, text]).imageInput.text,
    "Inspect 🐈 and literal [Image #2]",
  );
  for (const content of [
    null,
    [],
    [text],
    [image],
    [image, image, text],
    [image, { ...text, text_elements: [] }],
    [image, { ...text, text_elements: [null] }],
    [
      image,
      {
        ...text,
        text_elements: [{ byte_range: { start: 1, end: 11 }, placeholder: "[Image #1]" }],
      },
    ],
    [image, { ...text, text: "Literal [Image #1]" }],
    [{ ...image, image_url: "https://example.invalid/image.png" }, text],
    [{ ...image, image_url: "data:image/png;base64,!invalid" }, text],
    [image, text, { type: "text", text: "another block" }],
  ])
    assert.deepEqual(codexImageInput(content), {});
});
