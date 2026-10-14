import test from "node:test";
import assert from "node:assert/strict";
import { assertJoinedAtBreaks, withoutTags } from "../helpers/telegram-parts.js";
import {
  markdownToTelegramHtml,
  splitTelegramHtml,
  telegramParts,
} from "../../server/features/assistant-channels/telegram-format.js";

const split = (markdown, limit) =>
  splitTelegramHtml(markdownToTelegramHtml(markdown), limit);
const balanced = (part) => {
  const stack = [];
  for (const [, close, name] of part.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (close) assert.equal(stack.pop(), name, part);
    else stack.push(name);
  }
  assert.deepEqual(stack, [], part);
};
const sentence = (n) => `Sentence ${n} tells a little more about the topic at hand.`;
const paragraph = (p, count = 20) =>
  Array.from({ length: count }, (_, n) => sentence(`${p}.${n}`)).join(" ");

test("parts end between paragraphs before lines, sentences and words", () => {
  const paragraphs = Array.from({ length: 6 }, (_, p) => paragraph(p));
  const parts = split(paragraphs.join("\n\n"), 4000);
  assert.ok(parts.length > 1);
  // Every part holds whole paragraphs, in order.
  assert.deepEqual(parts.join("\n\n"), paragraphs.join("\n\n"));
  for (const part of parts) assert.ok(part.length <= 4000);

  const lines = Array.from({ length: 120 }, (_, n) => sentence(n));
  const byLine = split(lines.join("\n"), 1000);
  assert.deepEqual(byLine.join("\n"), lines.join("\n"));

  const long = paragraph("x", 60);
  const bySentence = split(long, 1000);
  assert.ok(bySentence.length > 1);
  for (const part of bySentence) assert.match(part, /about the topic at hand\.$/);
  assert.equal(bySentence.join(" "), long);
});

test("a link, inline code or code line at the limit moves whole to the next part", () => {
  const filler = "word ".repeat(196);
  const link = "[Quelle: Example news article](https://news.example/2026/10/14/article)";
  const parts = split(`${filler}${link} and more text after it.`, 1000);
  assert.equal(parts.length, 2);
  assert.match(
    parts[1],
    /^<a href="https:\/\/news\.example\/2026\/10\/14\/article">Quelle: Example news article<\/a>/,
  );
  assert.ok(!parts.join("").includes("[Q"));

  const code = split(`${filler}\`npm run test -- --watch with spaces\` done`, 1000);
  assert.match(code[1], /^<code>npm run test -- --watch with spaces<\/code> done$/);

  // A code block longer than a part is split at its lines, each part a block.
  const block = Array.from({ length: 80 }, (_, n) => `const value${n} = compute(${n});`);
  const blocks = split(`Intro.\n\n\`\`\`js\n${block.join("\n")}\n\`\`\``, 1000);
  assert.ok(blocks.length > 2);
  assert.match(blocks[0], /^Intro\.\n\n<pre><code class="language-js">const value0 = /);
  const shown = [];
  for (const [n, part] of blocks.entries()) {
    if (n) assert.match(part, /^<pre><code class="language-js">const value\d+ = /);
    assert.match(part, /\);<\/code><\/pre>$/, "a part ends after a whole code line");
    shown.push(withoutTags(part.replace(/^Intro\.\n\n/, "")));
  }
  assert.equal(shown.join("\n"), block.join("\n"));
});

test("bold text across the limit is closed and reopened, never left open", () => {
  const parts = split(`**${"strong words ".repeat(200)}end**`, 1000);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= 1000);
    assert.match(part, /^<b>.*<\/b>$/s);
    balanced(part);
  }
  // Short bold text at the limit moves whole instead.
  const moved = split(`${"word ".repeat(196)}**bold heading here** tail`, 1000);
  assert.match(moved[1], /^<b>bold heading here<\/b> tail$/);
});

test("a single word or URL longer than a part is cut at the limit, losing nothing", () => {
  const url = `https://example.com/${"a".repeat(9000)}`;
  const parts = split(url, 4000);
  assert.equal(parts.length, 3);
  assert.deepEqual(
    parts.map((p) => p.length),
    [4000, 4000, url.length - 8000],
  );
  assert.equal(parts.join(""), url);
  // A word that does not fit follows the text before it into a part of its own.
  const after = split(`Look here: ${"b".repeat(5000)}`, 4000);
  assert.equal(after[0], "Look here:");
  assert.equal(after.slice(1).join(""), "b".repeat(5000));
});

test("emoji and other surrogate pairs are never split", () => {
  const emoji = "🙂".repeat(3000);
  const parts = split(emoji, 4000);
  assert.equal(parts.join(""), emoji);
  for (const part of parts) {
    assert.ok(part.length <= 4000);
    assert.doesNotMatch(part, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  }
  const odd = split(`a${"😀".repeat(2500)}`, 4000);
  assert.equal(odd.join(""), `a${"😀".repeat(2500)}`);
  assert.equal(odd[0].length, 3999);
});

test("text exactly at the limit is one part, one character more is two", () => {
  assert.deepEqual(splitTelegramHtml("x".repeat(4000)), ["x".repeat(4000)]);
  // The space that would make 4001 is the break.
  assert.deepEqual(splitTelegramHtml(`${"x".repeat(3000)} ${"y".repeat(1000)}`), [
    "x".repeat(3000),
    "y".repeat(1000),
  ]);
  const exact = `${"x".repeat(3996)} yyy`;
  assert.deepEqual(splitTelegramHtml(exact), [exact]);
  assert.deepEqual(splitTelegramHtml(`${exact}y`), ["x".repeat(3996), "yyyy"]);
  // Markup counts: a tag pushing the part over the limit moves it on.
  assert.deepEqual(splitTelegramHtml(`${"x".repeat(3990)} <b>bold</b>`), [
    "x".repeat(3990),
    "<b>bold</b>",
  ]);
});

test("every durable part stays within Telegram's limit in both renderings", () => {
  const markdown = Array.from(
    { length: 30 },
    (_, n) =>
      `## Heading ${n}\n${paragraph(n, 4)} [Quelle ${n}](https://news.example/${n}?a=1&b=2)`,
  ).join("\n\n");
  const parts = telegramParts(markdown);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.html.length <= 4000);
    assert.ok(part.text.length <= 4000);
    balanced(part.html);
    assert.match(part.html, /^<b>Heading \d+<\/b>/);
  }
});

test("a code block split keeps every line's indentation and blank lines", () => {
  const code = Array.from({ length: 300 }, (_, n) =>
    n % 7 === 6 ? "" : `${" ".repeat((n % 4) * 4)}y${n} = value(${n})  `,
  );
  const html = markdownToTelegramHtml(`\`\`\`python\n${code.join("\n")}\n\`\`\``);
  const parts = splitTelegramHtml(html, 1000);
  assert.ok(parts.length > 3);
  const inner = (part) =>
    part.replace(/^<pre><code class="language-python">|<\/code><\/pre>$/g, "");
  // Only one line break per boundary is dropped; indentation and trailing spaces stay.
  const dropped = assertJoinedAtBreaks(code.join("\n"), parts.map(inner));
  assert.deepEqual(new Set(dropped), new Set(["\n"]));
  assert.ok(
    parts.slice(1).some((part) => /^<pre><code class="language-python"> {4}/.test(part)),
  );
});

test("a sentence that ends inside formatting counts as a sentence end", () => {
  const html = `${"word ".repeat(150)}<b>Done.</b> ${"more words ".repeat(30)}`;
  const parts = splitTelegramHtml(html.trim(), 1000);
  assert.equal(parts[0], `${"word ".repeat(150)}<b>Done.</b>`);
});
