import test from "node:test";
import assert from "node:assert/strict";
import { highlightRows, tokenLines } from "../../web/components/diff/diff-highlight.js";
import { fileLanguage } from "../../web/components/diff/file-language.js";

test("a multiline comment keeps its token class on every line", () => {
  const lines = tokenLines("/* a\n * b */\nconst x = 1;", "javascript");
  assert.ok(lines[1][0].classes.includes("hljs-comment"));
});

test("hunks reset context and sides are tokenized apart", () => {
  const map = highlightRows(
    [
      { kind: "remove", text: "/* open" },
      { kind: "add", text: "const a = 1;" },
      { kind: "meta", text: "@@ -9 +9 @@" },
      { kind: "context", text: "const b = 2;" },
    ],
    "javascript",
  );
  assert.ok(!map.get(1).some((t) => t.classes.includes("hljs-comment")));
  assert.equal(map.has(2), false);
  assert.ok(!map.get(3).some((t) => t.classes.includes("hljs-comment")));
});

test("unregistered languages and oversized text stay plain", () => {
  assert.deepEqual(tokenLines("a\nb", "plaintext"), [
    [{ value: "a", classes: [] }],
    [{ value: "b", classes: [] }],
  ]);
  assert.equal(fileLanguage("src/a.TSX"), "typescript");
  assert.equal(fileLanguage("README"), "plaintext");
});
