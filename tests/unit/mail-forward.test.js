import test from "node:test";
import assert from "node:assert/strict";
import {
  forwardFields,
  forwardSubject,
} from "../../server/features/mail/mail-forward.js";
import {
  htmlBounds as quoteBounds,
  htmlWithinBounds as quotable,
  quoteHtml as quotedHtml,
} from "../../server/features/mail/mail-text.js";
import { forwardInput } from "../../server/features/assistants/mail/agent-mail-send-input.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

const original = {
  envelope: {
    from: { name: "Telekom", address: "rechnung@telekom.de" },
    to: [{ name: "", address: "agent@example.com" }],
    date: "2026-10-01T08:00:00.000Z",
    subject: "Rechnung September",
  },
  text: "Ihre Rechnung für September liegt bei.",
  html: "<p>Original</p>",
  htmlOmitted: false,
  rawParts: [],
  parts: [],
};

const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return toolError(error).code;
  }
  throw new Error("no error");
};

test("the quote has a header block and the original text", () => {
  const { fields, html } = forwardFields(original, {
    body: "FYI",
    to: ["bob@example.org"],
  });
  assert.equal(fields.subject, "Fwd: Rechnung September");
  assert.match(
    fields.body,
    /^FYI\n\n---------- Forwarded message ----------\nFrom: Telekom <rechnung@telekom.de>\nDate: .+\nSubject: Rechnung September\nTo: agent@example.com\n\nIhre Rechnung/,
  );
  assert.ok(fields.body.endsWith(original.text));
  assert.deepEqual(fields.to, ["bob@example.org"]);
  assert.match(html, /<blockquote type="cite"><p>Original<\/p><\/blockquote>/);
  assert.match(html, /^<p>FYI<\/p>/);
  assert.match(html, /From: Telekom &lt;rechnung@telekom.de&gt;/);
});

test("Fwd and WG subjects are not prefixed twice", () => {
  for (const subject of [
    "Fwd: Rechnung",
    "FW: Rechnung",
    "WG: Rechnung",
    "fwd:x",
    "wg :x",
  ])
    assert.equal(forwardSubject(subject), subject.trim());
  assert.equal(forwardSubject("Re: Rechnung"), "Fwd: Re: Rechnung");
  assert.equal(forwardSubject("Forward planning"), "Fwd: Forward planning");
  const wg = { ...original, envelope: { ...original.envelope, subject: "WG: Angebot" } };
  assert.equal(
    forwardFields(wg, { to: ["bob@example.org"] }).fields.subject,
    "WG: Angebot",
  );
  // The agent's own subject wins.
  assert.equal(
    forwardFields(original, { to: ["bob@example.org"], subject: "Bitte prüfen" }).fields
      .subject,
    "Bitte prüfen",
  );
});

test("the agent's text is escaped in the HTML and an empty body starts with the quote", () => {
  const { fields, html } = forwardFields(original, {
    body: "<b>see</b>\r\nbelow",
    to: ["bob@example.org"],
  });
  assert.match(fields.body, /^<b>see<\/b>\nbelow\n\n----------/);
  assert.match(html, /^<p>&lt;b&gt;see&lt;\/b&gt;<br>\nbelow<\/p>/);
  const bare = forwardFields(original, { to: ["bob@example.org"] });
  assert.match(bare.fields.body, /^---------- Forwarded message ----------\n/);
  assert.match(bare.html, /^<p>---------- Forwarded message ----------<br>/);
  const plain = forwardFields({ ...original, html: null }, { to: ["bob@example.org"] });
  assert.equal(plain.html, null);
});

test("control characters in the original's header cannot break the quote or subject", () => {
  const hostile = {
    ...original,
    envelope: {
      ...original.envelope,
      from: { name: "Eve\r\nTo: boss@corp.example", address: "eve@example.net" },
      subject: "Hi\r\nBcc: x@y.z",
    },
  };
  const { fields } = forwardFields(hostile, { to: ["bob@example.org"] });
  assert.equal(fields.subject, "Fwd: Hi Bcc: x@y.z");
  assert.match(fields.body, /\nFrom: Eve To: boss@corp.example <eve@example.net>\n/);
});

test("a forward body over 100,000 characters is MAIL_DRAFT_UNSUPPORTED", () => {
  const long = { ...original, text: "x".repeat(99_950) };
  assert.equal(
    codeOf(() => forwardFields(long, { body: "FYI", to: ["bob@example.org"] })),
    "MAIL_DRAFT_UNSUPPORTED",
  );
  const fits = { ...original, text: "x".repeat(90_000) };
  assert.ok(forwardFields(fits, { body: "FYI", to: ["bob@example.org"] }).fields.body);
});

test("forwardInput checks the forward's fields before anything is read", () => {
  const base = { action: "forward", accountId: "a", uid: 7, to: ["bob@example.org"] };
  assert.deepEqual(forwardInput(base), {
    forward: { folder: "INBOX", uid: 7, includeAttachments: true },
    fields: { to: ["bob@example.org"], cc: [], bcc: [], subject: null, body: "" },
    attachments: [],
  });
  const full = forwardInput({
    ...base,
    folder: "Archiv",
    includeAttachments: false,
    subject: "Zur Info",
    body: "a\r\nb",
    attachments: [{ path: "offer.pdf" }],
  });
  assert.deepEqual(full.forward, { folder: "Archiv", uid: 7, includeAttachments: false });
  assert.equal(full.fields.subject, "Zur Info");
  assert.equal(full.fields.body, "a\nb");
  assert.deepEqual(full.attachments, [{ path: "offer.pdf" }]);
  for (const bad of [
    { ...base, to: [] },
    { ...base, uid: undefined },
    { ...base, uid: 0 },
    { ...base, folder: "IN\nBOX" },
    { ...base, draftUid: 3 },
    { ...base, replyToUid: 3 },
    { ...base, includeAttachments: "yes" },
    { ...base, attachments: [{ path: "a.pdf" }, { path: "a.pdf" }] },
    { ...base, attachments: [{ path: "a\u0000.pdf" }] },
    {
      ...base,
      attachments: Array.from({ length: 21 }, (_, i) => ({ path: `${i}.pdf` })),
    },
  ])
    assert.equal(
      codeOf(() => forwardInput(bad)),
      "INVALID_INPUT",
      JSON.stringify(bad),
    );
});

test("the quoted HTML keeps only the body and cannot restyle the agent's text", () => {
  const hostile = [
    '<html><head><base href="https://evil.example/"><style>p { display: none }</style>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
    '<link rel="stylesheet" href="https://evil.example/x.css"><title>T</title></head>',
    "<body><style>body { color: white }</style><script>steal()</script>",
    "<!--[if mso]><style>p { display: none }</style><![endif]--><!-- note -->",
    '<div style="/**/position:fixed;top:0;left:0;width:100%;height:100%">cover</div>',
    '<p style="color: red">Rechnung</p><img src="cid:logo" alt="Logo">',
    '<iframe src="https://evil.example/"></iframe><object data="x"></object>',
    '<embed src="x"><form action="https://evil.example/"><input name="pw"></form>',
    '<meta charset="x"><plaintext></body></html>',
  ].join("");
  const quoted = quotedHtml(hostile);
  assert.equal(quoted, '<div>cover</div><p>Rechnung</p><img src="cid:logo" alt="Logo">');
  assert.equal(quotedHtml("<p>Original</p>"), "<p>Original</p>");
  const { html } = forwardFields(
    { ...original, html: quoted },
    { body: "Bitte zahlen", to: ["bob@example.org"] },
  );
  // The agent's text and the header block come first, outside the quote, and nothing
  // in the forward can style, move or hide them.
  assert.match(html, /^<p>Bitte zahlen<\/p>\n<p>---------- Forwarded message/);
  assert.ok(html.indexOf("Bitte zahlen") < html.indexOf('<blockquote type="cite">'));
  assert.ok(html.endsWith(`<blockquote type="cite">${quoted}</blockquote>`));
  assert.doesNotMatch(
    html,
    /<(style|script|base|meta|link|head|body|html|iframe|object|embed|form|input|plaintext)\b|<!--|style=/i,
  );
});

test("hostile nesting is not parsed and returns within a second", () => {
  for (const [name, html] of [
    ["deep div", "<div>".repeat(200_000)],
    ["adoption agency", "<a><b><i>".repeat(100_000)],
    ["many b", "<b>".repeat(300_000)],
    ["many tags", "<br>".repeat(quoteBounds.tags + 1)],
    ["just too deep", "<div>".repeat(quoteBounds.depth + 1)],
  ]) {
    const started = performance.now();
    assert.equal(quotedHtml(html), null, name);
    assert.ok(performance.now() - started < 1000, name);
  }
});

test("an ordinary large newsletter is still quoted", () => {
  // Nested layout tables, unclosed paragraphs and list items: 12,500 start tags.
  const row = "<tr><td><table><tr><td><p>Item<li>a<li>b<br><img src=x></td></tr></table>";
  const html = `<html><body><table>${row.repeat(1250)}</table></body></html>`;
  assert.ok(quotable(html));
  const started = performance.now();
  const quoted = quotedHtml(html);
  assert.ok(performance.now() - started < 1000);
  assert.match(quoted, /^<table><tbody><tr><td><table>/);
  assert.ok(quotable("<div>".repeat(quoteBounds.depth)));
});
