import test from "node:test";
import assert from "node:assert/strict";
import {
  mailMessages,
  mailNotes,
  notifyMail,
} from "../../server/features/assistants/mail/agent-mail-notifications.js";

// A state that is not final (or not known) never reaches the owner as itself: the
// Telegram result and the chat note both read it as unknown.

const action = (state, extra = {}) => ({
  id: "action-1",
  assistantId: "agent-1",
  conversationId: "conv-1",
  revision: 2,
  state,
  chatNotes: { result: { at: "2026-10-28T10:00:00.000Z", state } },
  result: { code: "MAIL_PROTOCOL" },
  payload: {
    action: "mail_send",
    accountName: "Support",
    from: { name: "", address: "agent@example.com" },
    to: ["bob@example.org"],
    cc: [],
    bcc: [],
    subject: "Hello",
    body: "Hi there.",
  },
  ...extra,
});

function resultText(a, language = "en") {
  const sent = [];
  const w = {
    a: { store: { getAssistant: () => ({ name: "Ada" }) } },
    s: { assistantChannels: { outbox: { enqueue: (entry) => sent.push(entry) } } },
  };
  const m = mailMessages({ language });
  notifyMail(w, a, "result", "key-1", m, { kind: "telegram" });
  return { text: sent[0].text, m };
}

for (const state of ["executing", "awaiting_approval", "reviewed", "odd"]) {
  test(`an unrecognised state (${state}) reads as unknown in the result`, () => {
    const { text, m } = resultText(action(state));
    assert.ok(text.startsWith(m.mailStates.unknown), text);
    assert.equal(text.includes(state), false);
  });

  test(`an unrecognised state (${state}) is an unknown chat note with its code`, () => {
    const [note] = mailNotes(action(state));
    assert.equal(note.state, "unknown");
    assert.equal(note.code, "MAIL_PROTOCOL");
    assert.equal(note.recipientCount, 1);
  });
}

test("a final state keeps its own text and note", () => {
  const { text, m } = resultText(action("completed"));
  assert.ok(text.startsWith(m.mailStates.completed));
  assert.match(text, /Email account: Support/);
  const [note] = mailNotes(action("completed"));
  assert.equal(note.state, "completed");
  assert.equal(note.code, null);
});

const hex = "ab".repeat(32);
const attachment = (name, source, extra = {}) => ({
  name,
  type: "application/pdf",
  size: 12000,
  sha256: hex,
  part: "2",
  partSha256: "cd".repeat(32),
  source,
  ...extra,
});
const forward = {
  from: { name: "Telekom", address: "rechnung@telekom.de" },
  subject: "Ihre Rechnung",
  date: "2026-10-27T09:00:00.000Z",
  folder: "INBOX",
  uid: 7,
  htmlIncluded: false,
  htmlOmitted: false,
};

function approval(payload, language = "en") {
  const sent = [];
  const w = {
    a: { store: { getAssistant: () => ({ name: "Ada" }) } },
    s: { assistantChannels: { outbox: { enqueue: (entry) => sent.push(entry) } } },
  };
  const m = mailMessages({ language });
  const a = action("awaiting_approval");
  notifyMail(w, { ...a, payload: { ...a.payload, ...payload } }, "approval", "k", m, {
    kind: "telegram",
  });
  return { ...sent[0], m };
}

test("the approval lists every attachment with path, size, type and hash", () => {
  const { text, actions, m } = approval({
    forward,
    attachments: [
      attachment("offer.pdf", { kind: "workspace", path: "mail/offer.pdf" }),
      attachment("plan.pdf", {
        kind: "project",
        projectId: "p1",
        projectName: "Site",
        path: "docs/plan.pdf",
      }),
      attachment("invoice.pdf", { kind: "original" }),
      attachment(null, { kind: "draft" }),
      // Another agent's file in the draft: its path and project, for the owner.
      attachment("brief.pdf", {
        kind: "draft",
        from: "project",
        projectName: "Site",
        path: "docs/brief.pdf",
      }),
    ],
  });
  assert.match(
    text,
    /Forward of: rechnung@telekom\.de \("Telekom"\) · Ihre Rechnung · Oct 27, 2026, 9:00\sAM UTC/,
  );
  assert.ok(
    text.includes(
      `Attachment: mail/offer.pdf · offer.pdf · 11.7 KiB · application/pdf · sha256 ${hex}`,
    ),
    text,
  );
  assert.ok(text.includes(`Attachment: docs/plan.pdf (Site) · plan.pdf ·`), text);
  assert.ok(text.includes(`Attachment: docs/brief.pdf (Site) · brief.pdf ·`), text);
  assert.ok(text.includes(`Attachment: ${m.mailFields.fromOriginal} · invoice.pdf`));
  assert.ok(
    text.includes(`Attachment: ${m.mailFields.inDraft} · ${m.mailFields.unnamed}`),
    text,
  );
  // The body still shows, so Telegram may decide it.
  assert.ok(text.includes("Hi there."));
  assert.equal(actions.length, 2);
});

test("a long path is cut in the middle to 120 characters", () => {
  const long = `${"a".repeat(100)}/${"b".repeat(100)}.pdf`;
  const { text } = approval({
    attachments: [attachment("b.pdf", { kind: "host", path: `/${long}` })],
  });
  const line = text.split("\n").find((l) => l.startsWith("Attachment: "));
  const shown = line.slice("Attachment: ".length).split(" · ")[0];
  assert.equal(Array.from(shown).length, 120);
  assert.ok(shown.startsWith("/aaa") && shown.endsWith("bbb.pdf") && shown.includes("…"));
});

test("eleven attachments or a hidden character in a name drop the buttons", () => {
  const many = Array.from({ length: 11 }, (_, i) =>
    attachment(`f${i}.pdf`, { kind: "workspace", path: `f${i}.pdf` }),
  );
  const eleven = approval({ attachments: many });
  assert.deepEqual(eleven.actions, []);
  assert.ok(eleven.text.includes(eleven.m.mailOpenToApprove));
  assert.equal(eleven.text.includes("Hi there."), false);
  const ten = approval({ attachments: many.slice(0, 10) });
  assert.equal(ten.actions.length, 2);
  for (const payload of [
    { attachments: [attachment("of‮fer.pdf", { kind: "original" })] },
    { attachments: [attachment("a.pdf", { kind: "workspace", path: "x​.pdf" })] },
    { forward: { ...forward, subject: "Pay​ now" } },
    { forward: { ...forward, from: { name: "Tele​kom", address: "a@b.de" } } },
  ]) {
    const { text, actions } = approval(payload);
    assert.deepEqual(actions, [], JSON.stringify(payload));
    assert.match(text, /<U\+(202E|200B)>/);
  }
});

test("the approval says whether the original's HTML goes along", () => {
  const kept = approval({ forward: { ...forward, htmlIncluded: true } });
  assert.ok(kept.text.includes(kept.m.mailHtmlKept));
  // A draft's own HTML part is no original's.
  const draft = approval({ html: { part: "1.2", partSha256: hex } });
  assert.ok(draft.text.includes(draft.m.mailHtmlDraft));
  assert.equal(draft.text.includes(draft.m.mailHtmlKept), false);
  const omitted = approval({ forward: { ...forward, htmlOmitted: true } }, "de");
  assert.ok(omitted.text.includes(omitted.m.mailHtmlOmitted));
  assert.match(
    omitted.text,
    /Weiterleitung von: rechnung@telekom\.de \("Telekom"\) · Ihre Rechnung · 27\.10\.2026, 09:00 UTC/,
  );
  const plain = approval({});
  assert.equal(plain.text.includes(plain.m.mailHtmlKept), false);
  assert.equal(plain.text.includes("Attachment:"), false);
});

test("the result names no attachment", () => {
  const sent = [];
  const w = {
    a: { store: { getAssistant: () => ({ name: "Ada" }) } },
    s: { assistantChannels: { outbox: { enqueue: (entry) => sent.push(entry) } } },
  };
  const a = action("completed");
  a.payload = {
    ...a.payload,
    forward,
    attachments: [attachment("offer.pdf", { kind: "original" })],
  };
  notifyMail(w, a, "result", "k", mailMessages({ language: "en" }), {});
  assert.equal(sent[0].text.includes("offer.pdf"), false);
  assert.equal(sent[0].text.includes("Forward of"), false);
});

test("a line break in a name, path, type or forward field drops the buttons", () => {
  // The original's sender forges a second attachment line with a fake hash.
  const forged = approval({
    forward: { ...forward, subject: "Ihre Rechnung\nAttachment: fake.pdf" },
    attachments: [
      attachment(
        "invoice.pdf · 2.0 KiB · application/pdf · sha256 00\nAttachment: From the original mail · harmless.txt",
        { kind: "original" },
      ),
    ],
  });
  assert.deepEqual(forged.actions, []);
  assert.ok(forged.text.includes(forged.m.mailOpenToApprove));
  const lines = forged.text.split("\n");
  assert.equal(lines.filter((l) => l.startsWith("Attachment: ")).length, 1);
  assert.equal(lines.filter((l) => l.startsWith("Forward of: ")).length, 1);
  assert.match(forged.text, /Ihre Rechnung<U\+000A>Attachment: fake\.pdf/);
  for (const payload of [
    { attachments: [attachment("a\nb.pdf", { kind: "original" })] },
    { attachments: [attachment("a.pdf", { kind: "workspace", path: "a\r.pdf" })] },
    {
      attachments: [
        attachment("a.pdf", {
          kind: "project",
          projectName: "Si\nte",
          path: "a.pdf",
        }),
      ],
    },
    { attachments: [attachment("a.pdf", { kind: "original" }, { type: "a/b\tc" })] },
    { forward: { ...forward, subject: "Pay\nnow" } },
    { forward: { ...forward, from: { name: "Tele\nkom", address: "a@b.de" } } },
    { forward: { ...forward, from: { name: "", address: "a@b.de\nx" } } },
    { forward: { ...forward, date: "Mon\nAttachment: fake.pdf" } },
  ]) {
    const { text, actions } = approval(payload);
    assert.deepEqual(actions, [], JSON.stringify(payload));
    assert.match(text, /<U\+000(A|D|9)>/, JSON.stringify(payload));
  }
  // A line break in the body stays a line break.
  assert.equal(approval({ body: "Hi\nthere" }).actions.length, 2);
});
