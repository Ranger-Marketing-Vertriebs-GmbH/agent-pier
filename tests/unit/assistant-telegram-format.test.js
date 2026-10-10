import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  markdownToTelegramHtml,
  splitTelegramHtml,
  telegramPlainText,
  telegramParts,
} from "../../server/features/assistant-channels/telegram-format.js";

const tag = /<\/?(?:b|i|s|code|pre|a)(?: (?:href|class)="[^"<>]*")?>/g;
const strayLessThan = (html) => html.replace(tag, "").includes("<");
// Visible text of Telegram HTML, independent of link targets.
const stripAll = (text) => {
  let previous;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, "");
  } while (text !== previous);
  return text;
};
const visible = (html) =>
  stripAll(html)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");

test("Markdown becomes Telegram HTML with strict escaping", () => {
  assert.equal(markdownToTelegramHtml("**bold** and *it*"), "<b>bold</b> and <i>it</i>");
  assert.equal(
    markdownToTelegramHtml("run `a<b> && c`"),
    "run <code>a&lt;b&gt; &amp;&amp; c</code>",
  );
  assert.equal(
    markdownToTelegramHtml("```js\nif (a < b && c) **x**\n```"),
    '<pre><code class="language-js">if (a &lt; b &amp;&amp; c) **x**</code></pre>',
  );
  assert.equal(
    markdownToTelegramHtml('[Docs](https://example.com/a?b=1&c="2")'),
    '<a href="https://example.com/a?b=1&amp;c=&quot;2&quot;">Docs</a>',
  );
  assert.equal(
    markdownToTelegramHtml("[bad](javascript:alert(1))"),
    "[bad](javascript:alert(1))",
  );
  assert.equal(
    markdownToTelegramHtml("<script>alert('x')</script> & more"),
    "&lt;script&gt;alert('x')&lt;/script&gt; &amp; more",
  );
  assert.equal(markdownToTelegramHtml("# Title\n- item"), "<b>Title</b>\n• item");
  assert.equal(markdownToTelegramHtml("snake_case_name 2*3*4"), "snake_case_name 2*3*4");
});

test("plain-text fallback keeps text and link targets without markup", () => {
  const html = markdownToTelegramHtml("**Done** & [open](https://example.com/x)");
  assert.equal(telegramPlainText(html), "Done & open: https://example.com/x");
  const [part] = telegramParts("Hi", {
    url: "https://pier.example/agents/a/chats/c",
    label: "Open in AgentPier",
  });
  assert.equal(
    part.html,
    'Hi\n\n<a href="https://pier.example/agents/a/chats/c">Open in AgentPier</a>',
  );
  assert.equal(
    part.text,
    "Hi\n\nOpen in AgentPier: https://pier.example/agents/a/chats/c",
  );
  assert.equal(part.state, "pending");
});

test("long formatted text splits into balanced parts without cutting tags or entities", () => {
  const html = markdownToTelegramHtml(`**${"a&b ".repeat(1500)}end**`);
  const parts = splitTelegramHtml(html, 4000);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= 4000);
    assert.match(part, /^<b>/);
    assert.match(part, /<\/b>$/);
    assert.ok(!/&[a-z]*$/.test(part.replace(/<\/b>$/, "")));
  }
  assert.equal(parts.map(visible).join(""), visible(html));
});

const markdownish = fc
  .array(
    fc.oneof(
      fc.string({ maxLength: 40 }),
      fc.constantFrom(
        "**",
        "*",
        "`",
        "```",
        "\n",
        "<",
        ">",
        "&",
        '"',
        "[x](https://e.com/?a=<b>)",
        `[long](https://e.com/${"a".repeat(1010)})`,
        `**[long](https://e.com/${"b".repeat(1100)})**`,
        `**[amp](https://e.com/?${"&".repeat(1000)})**`,
        `[amp](https://e.com/?${"&".repeat(200)})`,
        `~~[quote](https://e.com/${'"'.repeat(700)})~~`,
        "<script>",
        "~~",
        "# ",
        "🙂",
      ),
    ),
    { maxLength: 400 },
  )
  .map((pieces) => pieces.join(""));

test("formatted output never contains an unescaped < outside allowed tags", () => {
  fc.assert(
    fc.property(markdownish, (text) => {
      const html = markdownToTelegramHtml(text);
      assert.ok(!strayLessThan(html), html);
    }),
    { numRuns: 300 },
  );
});

test("splitting never cuts inside a tag, entity or surrogate pair and keeps tags balanced", () => {
  fc.assert(
    fc.property(markdownish, fc.integer({ min: 1200, max: 4000 }), (text, limit) => {
      const html = markdownToTelegramHtml(text);
      const parts = splitTelegramHtml(html, limit);
      assert.equal(parts.map(visible).join(""), visible(html));
      for (const part of parts) {
        assert.ok(part.length <= limit);
        assert.ok(!strayLessThan(part), part);
        assert.ok(!/<[^>]*$/.test(part));
        assert.ok(!/&[a-z#0-9]*$/.test(part));
        assert.ok(!/[\uD800-\uDBFF]$/.test(part));
        const stack = [];
        for (const [, close, name] of part.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
          if (close) assert.equal(stack.pop(), name);
          else stack.push(name);
        }
        assert.deepEqual(stack, []);
      }
    }),
    { numRuns: 300 },
  );
});

test("markup without visible text still yields a plain-text part", () => {
  const parts = telegramParts("```\n```");
  assert.deepEqual(parts, [{ text: "```\n```", html: null, state: "pending" }]);
});

test("overlong link targets render as text and never as a tag", () => {
  const url = `https://e.com/${"a".repeat(1100)}`;
  const html = markdownToTelegramHtml(`[x](${url})`);
  assert.ok(!html.includes("<a "));
  const [part] = telegramParts("Hi", { url, label: "Open" });
  assert.equal(part.html, "Hi");
});

test("escaped link targets are capped so no part exceeds the limit", () => {
  const html = markdownToTelegramHtml(`**[x](https://e.com/?${"&".repeat(1000)})**`);
  assert.ok(!html.includes("<a "));
  for (const part of splitTelegramHtml(html)) assert.ok(part.length <= 4000);
  const parts = telegramParts("hi", {
    url: `https://e.com/${'"'.repeat(1000)}`,
    label: "o",
  });
  assert.deepEqual(
    parts.map((p) => p.html),
    ["hi"],
  );
  const kept = markdownToTelegramHtml(`[x](https://e.com/?${"&".repeat(100)})`);
  assert.ok(kept.startsWith('<a href="https://e.com/?&amp;'));
});

test("plain-text rendering strips nested and overlapping tags", () => {
  assert.equal(telegramPlainText("<<b>b>x</b>"), "b>x");
  assert.equal(telegramPlainText("<scr<script>ipt>alert</script>"), "ipt>alert");
  assert.equal(telegramPlainText("a &lt;b&gt; <i>c</i>"), "a <b> c");
});
