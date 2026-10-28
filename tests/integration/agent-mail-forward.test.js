import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  carries,
  code,
  sendFilesFixture,
  sha256,
} from "../helpers/mail-send-files-fixture.js";
import { mimeWith, pdfWith } from "../helpers/mail-documents.js";
import {
  attachmentLimits,
  decodeTransfer,
} from "../../server/features/mail/mail-parts.js";
import { maxSendsPerHour } from "../../server/features/assistants/mail/agent-mail-sends.js";

const pdfType = "application/pdf";
const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/mail",
);

/** An original in INBOX from Telekom with `attachments`; returns its UID and raw. */
function original(f, { attachments = [], html } = {}) {
  const raw = mimeWith({
    subject: "Rechnung September",
    text: "Ihre Rechnung liegt bei.",
    html,
    attachments,
  }).replace("From: owner@example.com", "From: Telekom <rechnung@telekom.de>");
  const stored = f.imap.mailbox.append("INBOX", Buffer.from(raw, "latin1"));
  return { uid: stored.uid, raw };
}

const forwardOf = (f) => (input) =>
  f.mail({
    accountId: f.account.id,
    action: "forward",
    to: ["bob@example.org"],
    ...input,
  });

// The text/html part of an SMTP message, decoded to a string.
function htmlOf(raw) {
  const text = raw.toString("latin1");
  const found = text.match(/(Content-Type: text\/html;[^]*?)\r\n\r\n([^]*?)\r\n--/);
  if (!found) return null;
  const encoding = found[1].match(/Content-Transfer-Encoding: (\S+)/i)?.[1] ?? "7bit";
  return decodeTransfer(Buffer.from(found[2], "latin1"), encoding).toString("utf8");
}

test("a forward sends the original attachments byte for byte after approval", async (t) => {
  const f = await sendFilesFixture(t);
  const pdf = pdfWith("Rechnung 42");
  const { uid, raw } = original(f, {
    attachments: [{ name: "a.pdf", type: pdfType, content: pdf }],
  });
  // The part as the original carries it: header and base64 body in 76-column lines.
  const part = raw.match(
    /Content-Type: application\/pdf; name="a.pdf"\r\n[^]*?(?=\r\n--mix)/,
  )[0];
  assert.match(part, /\r\n\r\n[A-Za-z0-9+/]{76}\r\n/);
  const r = await forwardOf(f)({ uid, body: "FYI" });
  assert.equal(r.status, "awaiting_approval");
  const p = f.workflows.get(r.actionId).payload;
  assert.deepEqual(p.forward, {
    from: { name: "Telekom", address: "rechnung@telekom.de" },
    subject: "Rechnung September",
    date: "2026-10-27T13:00:00.000Z",
    folder: "INBOX",
    uid,
    htmlIncluded: false,
    htmlOmitted: false,
  });
  assert.equal(p.subject, "Fwd: Rechnung September");
  assert.match(
    p.body,
    /^FYI\n\n---------- Forwarded message ----------\nFrom: Telekom <rechnung@telekom.de>\nDate: Tue, 27 Oct 2026 13:00:00 GMT\nSubject: Rechnung September\nTo: bob@example.org\n\nIhre Rechnung liegt bei\.$/,
  );
  assert.equal(p.attachments.length, 1);
  const [a] = p.attachments;
  assert.deepEqual(a.source, { kind: "original" });
  assert.equal(a.name, "a.pdf");
  assert.equal(a.size, pdf.length);
  assert.equal(a.sha256, sha256(pdf));
  assert.equal(p.attachmentBytes, pdf.length);
  assert.equal(p.html, null);
  assert.equal(p.files, null);
  assert.equal(p.inReplyTo, null);
  assert.deepEqual(p.references, []);
  // The draft holds the forward; the original stays where it was.
  assert.equal(f.count("Drafts"), 1);
  assert.equal(f.count("INBOX"), 1);
  assert.equal(f.smtp.messages.length, 0);

  await f.decide(r.actionId);
  const row = await f.settled(r.actionId);
  assert.equal(row.state, "completed");
  assert.equal(f.smtp.messages.length, 1);
  const sent = f.smtp.messages[0].raw.toString("latin1");
  assert.ok(sent.includes(part), "the original part goes out unchanged");
  assert.doesNotMatch(sent, /^(In-Reply-To|References):/im);
  assert.match(sent, /^Subject: Fwd: Rechnung September\r$/m);
  assert.equal(f.count("Drafts"), 0);
  const [audit] = f.sent();
  assert.equal(audit.details.forward, true);
  assert.equal(audit.details.attachments, 1);
  assert.equal(audit.details.attachmentBytes, pdf.length);
  assert.equal(audit.details.delivery, "sent");
  assert.doesNotMatch(JSON.stringify(audit), /a\.pdf|Telekom|Rechnung/);
});

test("includeAttachments false leaves them out; extra files join", async (t) => {
  const f = await sendFilesFixture(t);
  const pdf = pdfWith("Original");
  const offer = pdfWith("Offer");
  fs.writeFileSync(f.ws("offer.pdf"), offer);
  const { uid } = original(f, {
    attachments: [{ name: "a.pdf", type: pdfType, content: pdf }],
  });
  const forward = forwardOf(f);

  const without = await forward({
    uid,
    includeAttachments: false,
    attachments: [{ path: "offer.pdf" }],
  });
  const p = f.workflows.get(without.actionId).payload;
  assert.deepEqual(
    p.attachments.map((x) => [x.name, x.source]),
    [["offer.pdf", { kind: "workspace", path: "offer.pdf" }]],
  );
  assert.equal(p.files.shell, "off");

  const both = await forward({ uid, attachments: [{ path: "offer.pdf" }] });
  const q = f.workflows.get(both.actionId).payload;
  assert.deepEqual(
    q.attachments.map((x) => [x.name, x.source]),
    [
      ["a.pdf", { kind: "original" }],
      ["offer.pdf", { kind: "workspace", path: "offer.pdf" }],
    ],
  );
  assert.equal(q.attachmentBytes, pdf.length + offer.length);

  await f.decide(without.actionId);
  assert.equal((await f.settled(without.actionId)).state, "completed");
  await f.decide(both.actionId);
  assert.equal((await f.settled(both.actionId)).state, "completed");
  const [first, second] = f.smtp.messages.map((m) => m.raw);
  assert.ok(carries(first, offer));
  assert.equal(carries(first, pdf), false);
  assert.ok(carries(second, pdf));
  assert.ok(carries(second, offer));
});

test("an HTML-only Latin-1 original is quoted as text and kept as HTML", async (t) => {
  const f = await sendFilesFixture(t);
  const markup =
    "<html><body><p>Sch=F6ne Gr=FC=DFe aus K=F6ln</p><p>Bis <b>bald</b></p></body></html>";
  const html = f.imap.mailbox.append(
    "INBOX",
    Buffer.from(
      `From: =?ISO-8859-1?Q?J=FCrgen?= <juergen@example.org>\r\nTo: agent@example.com\r\nSubject: Gruss\r\nDate: Mon, 26 Oct 2026 09:00:00 +0100\r\nMessage-ID: <h1@example.org>\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=ISO-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${markup}\r\n`,
      "latin1",
    ),
  );
  const latin1 = f.imap.mailbox.append(
    "INBOX",
    fs.readFileSync(path.join(fixtures, "plain-latin1.eml")),
  );
  const forward = forwardOf(f);

  const r = await forward({ uid: html.uid });
  const p = f.workflows.get(r.actionId).payload;
  assert.match(p.body, /\nFrom: Jürgen <juergen@example.org>\n/);
  assert.match(p.body, /\n\nSchöne Grüße aus Köln\n\nBis bald$/);
  assert.match(p.html.partSha256, /^[0-9a-f]{64}$/);
  assert.equal(p.forward.from.name, "Jürgen");
  assert.equal(p.forward.htmlIncluded, true);
  assert.equal(p.forward.htmlOmitted, false);
  assert.equal(r.htmlNote, undefined);

  const plain = await forward({ uid: latin1.uid });
  const q = f.workflows.get(plain.actionId).payload;
  assert.equal(q.subject, "Fwd: Grüße aus Köln");
  assert.match(q.body, /\nFrom: Jürgen Müller <juergen@example.org>\n/);
  assert.match(q.body, /schöne Grüße aus Köln\. Die Straße ist nass\./);
  assert.equal(q.html, null);

  await f.decide(r.actionId);
  assert.equal((await f.settled(r.actionId)).state, "completed");
  const sent = f.smtp.messages[0].raw;
  assert.match(sent.toString("latin1"), /multipart\/alternative/);
  const alternative = htmlOf(sent);
  // The content of the original's body, its markup kept, its line end included.
  assert.match(
    alternative,
    /<blockquote type="cite"><p>Schöne Grüße aus Köln<\/p><p>Bis <b>bald<\/b><\/p>\r?\n<\/blockquote>/,
  );
  assert.match(alternative, /From: Jürgen &lt;juergen@example.org&gt;/);
});

test("an HTML part over 1 MiB is left out and the result says so", async (t) => {
  const f = await sendFilesFixture(t);
  const { uid } = original(f, { html: `<p>${"x".repeat(1_100_000)}</p>` });
  const r = await forwardOf(f)({ uid });
  assert.equal(r.status, "awaiting_approval");
  assert.match(r.htmlNote, /over 1 MiB/);
  assert.equal(r.html, undefined);
  const p = f.workflows.get(r.actionId).payload;
  assert.equal(p.html, null);
  assert.equal(p.forward.htmlIncluded, false);
  assert.equal(p.forward.htmlOmitted, true);
  assert.match(p.body, /Ihre Rechnung liegt bei\.$/);
  await f.decide(r.actionId);
  assert.equal((await f.settled(r.actionId)).state, "completed");
  assert.equal(htmlOf(f.smtp.messages[0].raw), null);
});

test("an HTML part of exactly 1 MiB goes along, one byte more is left out", async (t) => {
  const f = await sendFilesFixture(t);
  const sized = (bytes) => `<p>${"x".repeat(bytes - 7)}</p>`;
  assert.equal(Buffer.byteLength(sized(1_048_576)), 1_048_576);
  const exact = original(f, { html: sized(1_048_576) });
  const over = original(f, { html: sized(1_048_577) });
  const forward = forwardOf(f);
  const kept = await forward({ uid: exact.uid });
  const p = f.workflows.get(kept.actionId).payload;
  assert.equal(kept.htmlNote, undefined);
  assert.match(p.html.partSha256, /^[0-9a-f]{64}$/);
  assert.equal(p.forward.htmlIncluded, true);
  assert.equal(p.forward.htmlOmitted, false);
  const dropped = await forward({ uid: over.uid });
  const q = f.workflows.get(dropped.actionId).payload;
  assert.match(dropped.htmlNote, /over 1 MiB/);
  assert.equal(q.html, null);
  assert.equal(q.forward.htmlOmitted, true);
});

test("an HTML-only original over 1 MiB is MAIL_DRAFT_UNSUPPORTED and saves nothing", async (t) => {
  const f = await sendFilesFixture(t);
  const big = f.imap.mailbox.append(
    "INBOX",
    Buffer.from(
      `From: news@example.com\r\nTo: agent@example.com\r\nSubject: Big\r\nDate: Mon, 26 Oct 2026 09:00:00 +0100\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n<p>${"y".repeat(1_100_000)}</p>\r\n`,
      "latin1",
    ),
  );
  assert.equal(await code(forwardOf(f)({ uid: big.uid })), "MAIL_DRAFT_UNSUPPORTED");
  assert.equal(f.count("Drafts"), 0);
  assert.equal(f.workflows.mail.sends.hourSends(f.id), 0);
  assert.equal(f.smtp.messages.length, 0);
});

test("deeply nested HTML is left out quickly; as the only part it is refused", async (t) => {
  const f = await sendFilesFixture(t);
  const nested = original(f, { html: "<div>".repeat(200_000) });
  const only = f.imap.mailbox.append(
    "INBOX",
    Buffer.from(
      `From: news@example.com\r\nTo: agent@example.com\r\nSubject: Deep\r\nDate: Mon, 26 Oct 2026 09:00:00 +0100\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${"<a><b><i>".repeat(100_000)}\r\n`,
      "latin1",
    ),
  );
  const forward = forwardOf(f);
  const started = Date.now();
  const r = await forward({ uid: nested.uid });
  assert.ok(Date.now() - started < 5000);
  assert.match(r.htmlNote, /too deeply nested/);
  const p = f.workflows.get(r.actionId).payload;
  assert.equal(p.html, null);
  assert.equal(p.forward.htmlIncluded, false);
  assert.equal(p.forward.htmlOmitted, true);
  assert.match(p.body, /Ihre Rechnung liegt bei\.$/);
  assert.equal(await code(forward({ uid: only.uid })), "MAIL_DRAFT_UNSUPPORTED");
  assert.equal(f.count("Drafts"), 1);
});

test("tags hidden in quoted attributes cannot make a forward parse slowly", async (t) => {
  const f = await sendFilesFixture(t);
  const hostile = '<div title="<">'.repeat(60_000);
  const alternative = original(f, { html: hostile });
  const only = f.imap.mailbox.append(
    "INBOX",
    Buffer.from(
      `From: news@example.com\r\nTo: agent@example.com\r\nSubject: Quoted\r\nDate: Mon, 26 Oct 2026 09:00:00 +0100\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${hostile}\r\n`,
      "latin1",
    ),
  );
  const forward = forwardOf(f);
  let started = Date.now();
  const r = await forward({ uid: alternative.uid });
  assert.ok(Date.now() - started < 1000);
  assert.match(r.htmlNote, /too deeply nested/);
  const p = f.workflows.get(r.actionId).payload;
  assert.equal(p.html, null);
  assert.equal(p.forward.htmlOmitted, true);
  started = Date.now();
  assert.equal(await code(forward({ uid: only.uid })), "MAIL_DRAFT_UNSUPPORTED");
  assert.ok(Date.now() - started < 1000);
  assert.equal(f.count("Drafts"), 1);
});

test("a forward parses the original's HTML off the event loop", async (t) => {
  const f = await sendFilesFixture(t);
  // One tag with ~130,000 unique attributes: tens of seconds for parse5.
  const probe = `<a ${Array.from({ length: 130_000 }, (_, i) => `a${i}`).join(" ")}>x</a>`;
  assert.ok(Buffer.byteLength(probe) < 1_048_576);
  const { uid } = original(f, { html: probe });
  let last = performance.now();
  let gap = 0;
  const timer = setInterval(() => {
    gap = Math.max(gap, performance.now() - last);
    last = performance.now();
  }, 20);
  const started = Date.now();
  let r;
  try {
    r = await forwardOf(f)({ uid });
  } finally {
    clearInterval(timer);
  }
  assert.ok(gap < 200, `the event loop stalled for ${gap} ms`);
  assert.ok(Date.now() - started < 7_000);
  assert.match(r.htmlNote, /too many tags/);
  const p = f.workflows.get(r.actionId).payload;
  assert.equal(p.html, null);
  assert.equal(p.forward.htmlOmitted, true);
  assert.match(p.body, /Ihre Rechnung liegt bei\.$/);
});

test("forward needs the send level and counts against the hourly limit", async (t) => {
  const f = await sendFilesFixture(t);
  const { uid } = original(f);
  const forward = forwardOf(f);
  f.grant({ level: "read" });
  assert.equal(await code(forward({ uid })), "MAIL_SEND_NOT_GRANTED");
  assert.equal(f.count("Drafts"), 0);

  f.grant();
  for (let i = 0; i < maxSendsPerHour - 1; i++)
    f.workflows.store.reserve({
      assistantId: f.id,
      conversationId: f.channel.conversationId,
      attemptId: null,
      origin: { kind: "owner" },
      key: `mail:seed:${i}`,
      state: "declined",
      payload: { action: "mail_send", trusted: false, accountId: f.account.id },
    });
  const r = await forward({ uid });
  assert.equal(r.status, "awaiting_approval");
  assert.equal(f.workflows.get(r.actionId).payload.action, "mail_send");
  assert.equal(f.workflows.mail.sends.hourSends(f.id), maxSendsPerHour);
  assert.equal(await code(forward({ uid })), "MAIL_SEND_LIMIT");
  assert.equal(await code(f.send({})), "MAIL_SEND_LIMIT");
  assert.equal(f.count("Drafts"), 1);
});

test("a matching recipient rule forwards without a card", async (t) => {
  const f = await sendFilesFixture(t, { rules: ["example.org"] });
  const pdf = pdfWith("Rule");
  const { uid } = original(f, {
    attachments: [{ name: "a.pdf", type: pdfType, content: pdf }],
  });
  const r = await forwardOf(f)({ uid });
  assert.equal(r.status, "sent");
  assert.equal(f.smtp.messages.length, 1);
  assert.ok(carries(f.smtp.messages[0].raw, pdf));
  const [audit] = f.sent();
  assert.deepEqual(audit.details, {
    kind: "message",
    assistantId: f.id,
    actionId: r.actionId,
    authorizedBy: "rule",
    recipients: 1,
    delivery: "sent",
    attachments: 1,
    attachmentBytes: pdf.length,
    forward: true,
  });
});

test("too many or too large attachments are refused before a draft is saved", async (t) => {
  const f = await sendFilesFixture(t);
  fs.writeFileSync(f.ws("offer.pdf"), pdfWith("Offer"));
  const twenty = Array.from({ length: 20 }, (_, i) => ({
    name: `p${i}.pdf`,
    type: pdfType,
    content: pdfWith(`Part ${i}`),
  }));
  const { uid } = original(f, { attachments: twenty });
  const forward = forwardOf(f);
  assert.equal(
    await code(forward({ uid, attachments: [{ path: "offer.pdf" }] })),
    "INVALID_INPUT",
  );
  assert.equal(f.count("Drafts"), 0);
  // The twenty alone fit.
  const r = await forward({ uid });
  assert.equal(f.workflows.get(r.actionId).payload.attachments.length, 20);

  const big = original(f, {
    attachments: [{ name: "big.pdf", type: pdfType, content: Buffer.alloc(3000, 7) }],
  });
  f.workflows.mail.limits.attachments = { ...attachmentLimits, mailBytes: 2000 };
  assert.equal(await code(forward({ uid: big.uid })), "MAIL_ATTACHMENT_TOO_LARGE");
  assert.equal(f.count("Drafts"), 1);
  assert.equal(f.smtp.messages.length, 0);
});

test("an original changed in the draft after the card fails without SMTP", async (t) => {
  const f = await sendFilesFixture(t);
  const { uid } = original(f, {
    attachments: [{ name: "a.pdf", type: pdfType, content: pdfWith("Echt") }],
  });
  const r = await forwardOf(f)({ uid });
  const [message] = f.imap.folder("Drafts").messages;
  message.raw = Buffer.from(
    message.raw
      .toString("latin1")
      .replace(/^(Content-Disposition: attachment)/m, "$1;x=1"),
    "latin1",
  );
  delete message.parsed;
  await f.decide(r.actionId);
  const row = await f.settled(r.actionId);
  assert.equal(row.state, "failed");
  assert.equal(row.result.code, "MAIL_DRAFT_CHANGED");
  assert.equal(f.smtp.messages.length, 0);
  assert.equal(f.count("Drafts"), 1);
  const [audit] = f.sent();
  assert.equal(audit.details.delivery, "failed");
  assert.equal(audit.details.forward, true);
});

test("a forward of a missing message saves nothing", async (t) => {
  const f = await sendFilesFixture(t);
  assert.equal(await code(forwardOf(f)({ uid: 99 })), "MAIL_NOT_FOUND");
  assert.equal(f.count("Drafts"), 0);
  assert.equal(f.workflows.mail.sends.hourSends(f.id), 0);
});
