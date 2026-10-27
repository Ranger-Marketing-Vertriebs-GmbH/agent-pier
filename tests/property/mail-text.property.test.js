import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { htmlToText } from "../../server/features/mail/mail-text.js";

const escapeHtml = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

test("escaped text never gains a < and the text never exceeds maxChars", () => {
  fc.assert(
    fc.property(fc.string({ unit: "grapheme-ascii", maxLength: 300 }), (s) => {
      const { text } = htmlToText(escapeHtml(s), 1e6);
      if (!s.includes("<")) assert.equal(text.includes("<"), false);
      assert.ok(text.length <= 1e6);
    }),
  );
});

test("any markup stays within maxChars", () => {
  const tag = fc.constantFrom(
    "<p>",
    "</p>",
    "<br>",
    "<li>",
    "<script>",
    "</script>",
    "<a href='https://x.example/'>",
    "</a>",
    "<pre>",
    "</pre>",
    "<!--",
    "-->",
    "<style>",
  );
  const piece = fc.oneof(tag, fc.string({ maxLength: 20 }));
  fc.assert(
    fc.property(
      fc.array(piece, { maxLength: 40 }),
      fc.nat({ max: 200 }),
      (parts, max) => {
        const { text, truncated } = htmlToText(parts.join(""), max);
        assert.ok(text.length <= max);
        if (!truncated) assert.equal(text, text.trim());
      },
    ),
  );
});
