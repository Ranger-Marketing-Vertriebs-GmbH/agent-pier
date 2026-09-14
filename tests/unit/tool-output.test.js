import test from "node:test";
import assert from "node:assert/strict";
import { toolBlocks, outputPreview } from "../../web/features/chat/tool-output.js";

test("tool arguments decode multiline commands while preserving options and raw results", () => {
  const source =
    JSON.stringify({ cmd: 'printf "hello"\necho done', cwd: "/project", timeout: 1000 }) +
    "\n\nresult\\nkept";
  const blocks = toolBlocks(source, "exec_command");
  assert.equal(blocks[0].text, 'printf "hello"\necho done');
  assert.equal(blocks[0].language, "bash");
  assert.equal(blocks[1].text, "/project");
  assert.equal(blocks[2].text, "1000");
  assert.equal(blocks[3].text, "result\\nkept");
});
test("incomplete, malformed and very large JSON falls back without losing text", () => {
  for (const text of [
    '{"cmd":"unfinished',
    "{oops}",
    "{}oops",
    '{"x":' + " ".repeat(262144),
  ]) {
    assert.equal(toolBlocks(text)[0].text, text);
  }
  assert.equal(toolBlocks('[{"x":1}]')[0].language, "json");
  assert.equal(toolBlocks('{"nested":{"x":1}}')[0].text, '{\n  "x": 1\n}');
  assert.equal(toolBlocks("--- a\n+++ b\n-old\n+new")[0].language, "diff");
});
test("previews share a line and character budget across fields and can reveal the complete result", () => {
  const blocks = [
    { text: "a\nb", language: "plaintext" },
    {
      text: Array.from({ length: 20 }, (_, i) => String(i)).join("\n"),
      language: "plaintext",
    },
  ];
  const preview = outputPreview(blocks);
  assert.equal(preview.blocks[1].text, "0\n1\n2\n3\n4\n5");
  assert.equal(preview.truncated, true);
  assert.deepEqual(outputPreview(blocks, 200), { blocks, truncated: false });
  assert.equal(outputPreview([{ text: "x".repeat(100000) }]).blocks[0].text.length, 4000);
});

test("read and edit tools use explicit file extensions for code highlighting", () => {
  assert.equal(
    toolBlocks('{"file_path":"/project/app.ts"}\n\nconst ok: boolean = true;', "Read")[1]
      .language,
    "typescript",
  );
  assert.equal(
    toolBlocks('{"file_path":"/project/app.py","new_string":"return True"}', "Edit")[1]
      .language,
    "python",
  );
});
