import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { htmlToText } from "../../server/features/mail/mail-text.js";

const escapeHtml = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const count = (needle, text) => text.split(needle).length - 1;

test("escaped text never gains a < and the text never exceeds maxChars", () => {
  fc.assert(
    fc.property(
      fc.string({ unit: "grapheme-ascii", maxLength: 300 }),
      fc.nat({ max: 400 }),
      (s, max) => {
        const { text } = htmlToText(escapeHtml(s), 1e6);
        assert.ok(count("<", text) <= count("<", s));
        assert.ok(htmlToText(escapeHtml(s), max).text.length <= max);
      },
    ),
  );
});

test("markup of dropped and kept tags yields no <, no hidden payload and stays within maxChars", () => {
  const word = fc.stringMatching(/^[a-z ]{0,12}$/);
  const kept = fc.constantFrom("p", "b", "div", "li", "pre", "td", "h2", "span");
  const dropped = fc.constantFrom(
    "script",
    "style",
    "template",
    "noscript",
    "iframe",
    "title",
    "textarea",
    "svg",
  );
  const segment = fc.oneof(
    fc.tuple(kept, word).map(([tag, w]) => `<${tag}>${w}</${tag}>`),
    fc.tuple(dropped, word).map(([tag, w]) => `<${tag}>PAYLOAD ${w}</${tag}>`),
    word.map((w) => `<a href="https://x.example/${w.replace(/ /g, "")}">${w}</a>`),
    word.map((w) => `<!-- PAYLOAD ${w} -->`),
    fc.constant("<br>"),
    word,
  );
  fc.assert(
    fc.property(
      fc.array(segment, { maxLength: 30 }),
      fc.nat({ max: 300 }),
      (parts, max) => {
        const { text, truncated } = htmlToText(parts.join(""), max);
        assert.equal(text.includes("<"), false);
        assert.equal(text.includes("PAYLOAD"), false);
        assert.ok(text.length <= max);
        if (!truncated) assert.equal(text, text.trim());
      },
    ),
  );
});
