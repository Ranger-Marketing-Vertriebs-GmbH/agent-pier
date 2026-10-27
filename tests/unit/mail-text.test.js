import test from "node:test";
import assert from "node:assert/strict";
import { clipText, htmlToText } from "../../server/features/mail/mail-text.js";

test("html loses scripts and styles but keeps text and links", () => {
  const { text } = htmlToText(
    '<style>p{color:red}</style><p>Hi <b>Ann</b></p><script>x()</script><a href="https://a.example/x">site</a>',
    1000,
  );
  assert.equal(text, "Hi Ann\n\nsite (https://a.example/x)");
});

test("javascript: links keep only their text", () => {
  const { text } = htmlToText(
    '<p><a href="javascript:alert(1)">click</a> and <a href="data:text/html,x">data</a> and <a href="mailto:a@b.example">mail</a></p>',
    1000,
  );
  assert.equal(text, "click and data and mail (mailto:a@b.example)");
});

test("text is cut at maxChars and marked", () => {
  const html = `<p>${"word ".repeat(100)}</p>`;
  const cut = htmlToText(html, 20);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text.length, 20);
  assert.equal(cut.text, "word word word word ");
  const whole = htmlToText("<p>short</p>", 20);
  assert.deepEqual(whole, { text: "short", truncated: false });
});

test("head, template, comments and raw-text elements never reach the text", () => {
  const { text } = htmlToText(
    "<html><head><title>T</title><meta name=x></head><body><!-- secret --><template><p>tpl</p></template><noscript><img src=x></noscript><iframe><b>f</b></iframe><svg><text>s</text></svg><p>Body</p></body></html>",
    1000,
  );
  assert.equal(text, "Body");
});

test("blocks, breaks and list items become lines; blank lines collapse", () => {
  const { text } = htmlToText(
    "<h1>Title</h1><div>one<br>two</div><p></p><p></p><p></p><ul><li>a</li><li>b <i>c</i></li></ul><table><tr><td>x</td><td>y</td></tr><tr><td>z</td></tr></table>",
    1000,
  );
  assert.equal(text, "Title\n\none\ntwo\n\n- a\n- b c\n\nx y\nz");
});

test("pre keeps its whitespace and entities decode to text", () => {
  const { text } = htmlToText("<pre>a  b\n  c</pre><p>&lt;b&gt; &amp; &quot;</p>", 1000);
  assert.equal(text, 'a  b\n  c\n\n<b> & "');
});

test("a link whose text is its address shows it once", () => {
  const { text } = htmlToText(
    '<a href="https://a.example/">https://a.example/</a> <a href="https://b.example/"></a>',
    1000,
  );
  assert.equal(text, "https://a.example/ https://b.example/");
});

test("deeply nested markup does not overflow the stack", () => {
  const html = `${"<div>".repeat(50000)}deep${"</div>".repeat(50000)}`;
  assert.equal(htmlToText(html, 100).text, "deep");
});

test("clipText never splits a surrogate pair and marks the cut", () => {
  assert.deepEqual(clipText("ab😀c", 3), { text: "ab", truncated: true });
  assert.deepEqual(clipText("abc", 3), { text: "abc", truncated: false });
});

test("plaintext and textarea content never reaches the text", () => {
  assert.equal(htmlToText("<p>a</p><plaintext><script>x()</script>", 1000).text, "a");
  assert.equal(htmlToText("<p>a</p><textarea><b>x</b></textarea>", 1000).text, "a");
});

test("the word after a link is not glued to its address", () => {
  const { text } = htmlToText(
    '<p><a href="https://a.example/">site</a>more, <a href="https://b.example/">b</a>.</p>',
    1000,
  );
  assert.equal(text, "site (https://a.example/) more, b (https://b.example/).");
});

test("noscript content stays hidden even before the body", () => {
  assert.equal(htmlToText("<noscript>PAYLOAD</noscript><p>ok</p>", 1000).text, "ok");
});
