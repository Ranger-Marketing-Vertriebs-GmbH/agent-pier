import test from "node:test";
import assert from "node:assert/strict";
import { serializeDocument } from "../../web/features/files/file-text-format.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

for (const [name, document, text, expected] of [
  ["empty", { bom: false, lineEnding: "lf" }, "", ""],
  ["BOM only", { bom: true, lineEnding: "lf" }, "", "\uFEFF"],
  ["literal FEFF after BOM", { bom: true, lineEnding: "lf" }, "\uFEFFx", "\uFEFF\uFEFFx"],
  ["LF trailing lines", { bom: false, lineEnding: "lf" }, "a\n\n", "a\n\n"],
  [
    "CRLF without trailing line",
    { bom: true, lineEnding: "crlf" },
    "a\nb",
    "\uFEFFa\r\nb",
  ],
  ["CRLF with trailing lines", { bom: false, lineEnding: "crlf" }, "a\n\n", "a\r\n\r\n"],
])
  test(`serialization preserves ${name}`, () => {
    assert.deepEqual(
      serializeDocument(document, text),
      new TextEncoder().encode(expected),
    );
  });
test("mixed/bare CR requires an explicit conversion and preserves terminal count", () => {
  const doc = { bom: false, lineEnding: "mixed" };
  assert.throws(() => serializeDocument(doc, "a\rb\r\n"), {
    code: "FILE_LINE_ENDING_REQUIRED",
  });
  assert.deepEqual(
    serializeDocument(doc, "a\rb\r\n", { mixedLineEnding: "crlf" }),
    new TextEncoder().encode("a\r\nb\r\n"),
  );
});

test("the required line-ending choice stays reactive without retaining draft content", () => {
  let issue;
  try {
    serializeDocument({ lineEnding: "mixed", bom: false }, "private draft\r");
  } catch (error) {
    issue = error;
  }
  setLanguage("en", { persist: false });
  assert.match(issue.message, /Choose LF or CRLF/);
  setLanguage("de", { persist: false });
  assert.match(issue.message, /Wähle LF oder CRLF/);
  assert.equal(JSON.stringify(issue).includes("private draft"), false);
});
