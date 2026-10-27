import test from "node:test";
import assert from "node:assert/strict";
import { mailFixture } from "../helpers/agent-mail-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

const owner = { role: "owner" };
const withAttachment = `From: agent@example.com\r\nTo: bob@example.org\r\nSubject: With file\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nSee attached.\r\n--b1\r\nContent-Type: application/pdf; name="a.pdf"\r\nContent-Disposition: attachment; filename="a.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--b1--\r\n`;

const htmlOnly = `From: agent@example.com\r\nTo: bob@example.org\r\nSubject: Styled\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n<p>Hello</p>\r\n`;

async function code(promise) {
  try {
    await promise;
  } catch (error) {
    return toolError(error).code;
  }
  assert.fail("the call succeeded");
}

/** A send-level grant with `rules`, and the Drafts, Trash and Sent folders. */
async function sendFixture(t, { level = "send", rules } = {}) {
  const f = await mailFixture(t);
  f.grant(level, rules);
  f.imap.mailbox.add("Drafts", { specialUse: "\\Drafts" });
  f.imap.mailbox.add("Trash", { specialUse: "\\Trash" });
  f.imap.mailbox.add("Sent", { specialUse: "\\Sent" });
  f.workflows.mail.sends.pollMs = 10;
  // A card returns at once; the approval tests hold the call.
  f.workflows.mail.sends.holdMs = 30;
  const mail = (input, inv = f.ownTurn()) =>
    f.call(inv, { accountId: f.account.id, ...input });
  const send = (fields, inv) =>
    mail({ action: "send", subject: "Hello", body: "Hi there.", ...fields }, inv);
  const count = (path) => f.imap.folder(path).messages.length;
  const cards = () =>
    f.workflows.store
      .list(f.id)
      .filter((a) => a.payload.action === "mail_send" && a.state === "awaiting_approval");
  const sent = () => f.audit.filter((e) => e.action === "mail.sent");
  return { ...f, mail, send, count, cards, sent };
}

test("every recipient matching a rule sends without a card", async (t) => {
  const f = await sendFixture(t, { rules: ["example.org", "carol@partner.net"] });
  const result = await f.send({
    to: ['"Bob" <bob@example.org>'],
    cc: ["carol@partner.net"],
  });
  assert.equal(result.status, "sent");
  assert.equal(result.accountId, f.account.id);
  assert.equal(result.recipients, 2);
  assert.equal(typeof result.actionId, "string");
  assert.equal(f.smtp.messages.length, 1);
  const [message] = f.smtp.messages;
  assert.deepEqual(message.envelope, {
    from: "agent@example.com",
    to: ["bob@example.org", "carol@partner.net"],
  });
  const raw = message.raw.toString("utf8");
  assert.match(raw, /^Subject: Hello$/m);
  assert.match(raw, /Hi there\./);
  assert.equal(f.cards().length, 0);
  const row = f.workflows.get(result.actionId);
  assert.equal(row.payload.trusted, true);
  assert.equal(row.state, "completed");
  const [audit] = f.sent();
  assert.deepEqual(audit.details, {
    kind: "message",
    assistantId: f.id,
    actionId: result.actionId,
    authorizedBy: "rule",
    recipients: 2,
  });
  assert.equal(audit.outcome, "success");
  assert.equal(audit.resourceId, f.account.id);
  // The audit log names no address, subject or body.
  const log = JSON.stringify(f.audit);
  for (const text of ["example.org", "partner.net", "Hello", "Hi there"])
    assert.equal(log.includes(text), false, text);
});

test("one bcc outside the rule raises a card instead", async (t) => {
  const f = await sendFixture(t, { rules: ["example.org"] });
  const result = await f.send({
    to: ["bob@example.org"],
    bcc: ["eve@elsewhere.net"],
  });
  assert.equal(result.status, "awaiting_approval");
  assert.equal(f.smtp.messages.length, 0);
  const [card] = f.cards();
  assert.equal(card.id, result.actionId);
  assert.equal(card.payload.trusted, false);
  assert.deepEqual(card.payload.bcc, ["eve@elsewhere.net"]);
  assert.equal(f.sent().length, 0);
  // Declining keeps the draft saved first.
  assert.equal(f.count("Drafts"), 1);
});

test("display names, case and plus tags are matched on the addr-spec", async (t) => {
  const f = await sendFixture(t, { rules: ["bob@example.com", "example.org"] });
  const named = await f.send({ to: ['"Bob" <BOB@Example.com>'] });
  assert.equal(named.status, "sent");
  assert.deepEqual(f.smtp.messages[0].envelope.to, ["bob@example.com"]);
  const domain = await f.send({ to: ["Alice <alice+news@EXAMPLE.ORG>"] });
  assert.equal(domain.status, "sent");
  // A plus tag is part of the local part: an address rule does not cover it.
  const tagged = await f.send({ to: ["bob+tag@example.com"] });
  assert.equal(tagged.status, "awaiting_approval");
  assert.equal(f.smtp.messages.length, 2);
});

test("a lookalike domain and a subdomain never match", async (t) => {
  const f = await sendFixture(t, { rules: ["example.com"] });
  for (const to of [
    "a@evil.example.com",
    "a@example.com.evil.net",
    "a@examp1e.com",
    '"a@example.com" <a@evil.net>',
  ]) {
    const result = await f.send({ to: [to] });
    assert.equal(result.status, "awaiting_approval", to);
  }
  assert.equal(f.smtp.messages.length, 0);
  assert.equal(f.cards().length, 4);
});

test("read level refuses send with MAIL_SEND_NOT_GRANTED", async (t) => {
  const f = await sendFixture(t, { level: "read" });
  assert.equal(await code(f.send({ to: ["bob@example.org"] })), "MAIL_SEND_NOT_GRANTED");
  assert.equal(
    await code(f.mail({ action: "send", draftUid: 1 })),
    "MAIL_SEND_NOT_GRANTED",
  );
  assert.equal(f.count("Drafts"), 0, "no draft before the level check");
  assert.equal(f.smtp.messages.length, 0);
  assert.equal(f.workflows.store.list(f.id).length, 0);
  // Fields and a draft do not mix; a send needs a recipient.
  f.grant("send", ["example.org"]);
  assert.equal(
    await code(f.send({ draftUid: 1, to: ["bob@example.org"] })),
    "INVALID_INPUT",
  );
  assert.equal(await code(f.send({})), "INVALID_INPUT");
  assert.equal(
    await code(f.send({ to: ["bob@example.org"], folder: "x" })),
    "INVALID_INPUT",
  );
});

test("rule sends stop at 30 per hour with MAIL_SEND_LIMIT", async (t) => {
  const f = await sendFixture(t, { rules: ["example.org"] });
  const rows = [];
  for (let i = 0; i < 30; i++)
    rows.push(
      f.workflows.store.reserve({
        assistantId: f.id,
        conversationId: f.channel.conversationId,
        attemptId: null,
        origin: { kind: "owner" },
        key: `mail:seed:${i}`,
        state: "completed",
        payload: { action: "mail_send", trusted: true, accountId: f.account.id },
      }),
    );
  assert.equal(await code(f.send({ to: ["bob@example.org"] })), "MAIL_SEND_LIMIT");
  assert.equal(f.smtp.messages.length, 0);
  // A card is not a rule send and is not capped by it.
  assert.equal((await f.send({ to: ["eve@else.net"] })).status, "awaiting_approval");
  // An hour later the window has room again.
  const old = new Date(Date.now() - 3601000).toISOString();
  for (const row of rows) f.workflows.store.patch(row.id, { createdAt: old });
  assert.equal((await f.send({ to: ["bob@example.org"] })).status, "sent");
});

test("a sent draft moves to Trash and a copy lands in Sent when saveSent", async (t) => {
  const f = await sendFixture(t, { rules: ["example.org"] });
  const draft = await f.mail({
    action: "draft",
    to: ["Bob <bob@example.org>"],
    bcc: ["dana@example.org"],
    subject: "Quarterly",
    body: "Numbers attached below.\nLine two.",
  });
  const result = await f.mail({ action: "send", draftUid: draft.draftUid });
  assert.equal(result.status, "sent");
  assert.equal(result.savedToSent, true);
  assert.equal(result.recipients, 2);
  assert.equal(f.count("Drafts"), 0);
  assert.equal(f.count("Trash"), 1);
  assert.equal(f.count("Sent"), 1);
  const [message] = f.smtp.messages;
  assert.deepEqual(message.envelope.to, ["bob@example.org", "dana@example.org"]);
  const raw = message.raw.toString("utf8");
  assert.match(raw, /Subject: Quarterly/);
  assert.match(raw, /Line two\./);
  assert.doesNotMatch(raw, /^Bcc:/im, "recipients never see the Bcc");
  assert.match(raw, new RegExp(`Message-ID: ${draft.messageId}`));
  const copy = f.imap.folder("Sent").messages[0];
  assert.match(copy.raw.toString("utf8"), /^Bcc: dana@example.org/im);
  assert.ok(copy.flags.has("\\Seen"));
  // The sent draft going to Trash is audited like any Trash move, by count.
  assert.ok(f.audit.some((e) => e.action === "mail.deleted" && e.details.count === 1));
  // Without saveSent nothing is appended to Sent.
  f.mailStore.update(f.account.id, { saveSent: false }, owner);
  const plain = await f.send({ to: ["bob@example.org"] });
  assert.equal(plain.status, "sent");
  assert.equal(plain.savedToSent, false);
  assert.equal(f.count("Sent"), 1);
  assert.equal(f.count("Drafts"), 0, "the field send's own draft went to Trash");
});

test("a draft with an attachment is MAIL_ATTACHMENTS_UNSUPPORTED", async (t) => {
  const f = await sendFixture(t, { rules: ["example.org"] });
  const { uid } = f.imap.mailbox.append("Drafts", {
    raw: Buffer.from(withAttachment, "latin1"),
    flags: ["\\Draft"],
  });
  assert.equal(
    await code(f.mail({ action: "send", draftUid: uid })),
    "MAIL_ATTACHMENTS_UNSUPPORTED",
  );
  assert.equal(await code(f.mail({ action: "send", draftUid: 99 })), "MAIL_NOT_FOUND");
  assert.equal(f.smtp.messages.length, 0);
  assert.equal(f.count("Drafts"), 1);
  assert.equal(f.workflows.store.list(f.id).length, 0);
});

test("a failed send keeps the draft and is audited with its code", async (t) => {
  const f = await sendFixture(t, { rules: ["example.org"] });
  f.smtp.users["agent@example.com"] = "changed";
  assert.equal(await code(f.send({ to: ["bob@example.org"] })), "MAIL_AUTH_FAILED");
  assert.equal(f.count("Drafts"), 1);
  assert.equal(f.count("Sent"), 0);
  const [audit] = f.sent();
  assert.equal(audit.outcome, "failure");
  assert.equal(audit.details.code, "MAIL_AUTH_FAILED");
  assert.equal(audit.details.authorizedBy, "rule");
  assert.equal(JSON.stringify(f.audit).includes("pw-secret"), false);
});

test("a connection dropped after DATA is unknown and never sent again", async (t) => {
  const f = await sendFixture(t, { rules: ["example.org"] });
  f.smtp.dropAfterData = true;
  const inv = f.ownTurn();
  const result = await f.send({ to: ["bob@example.org"] }, inv);
  assert.equal(result.status, "unknown");
  assert.match(result.notice, /Do not send it again/);
  assert.equal(f.workflows.get(result.actionId).state, "unknown");
  assert.equal(f.smtp.messages.length, 1);
  assert.equal(f.count("Drafts"), 1, "the draft stays");
  const [audit] = f.sent();
  assert.equal(audit.outcome, "failure");
  assert.match(audit.details.code, /^MAIL_/);
  // A retry of the call returns the same answer and sends nothing.
  f.smtp.dropAfterData = false;
  const retry = await f.send({ to: ["bob@example.org"] }, inv);
  assert.deepEqual(retry, result);
  assert.equal(f.smtp.messages.length, 1);
  await f.workflows.tick();
  assert.equal(f.smtp.messages.length, 1);
});

test("rules narrowed between the gate and the send cancel a rule send", async (t) => {
  const f = await sendFixture(t, { rules: ["example.org"] });
  const withImap = f.mailStore.withImap.bind(f.mailStore);
  f.mailStore.withImap = async (id, fn) => {
    const result = await withImap(id, fn);
    // The owner narrows the rules while the draft is being saved.
    f.grant("send", ["other.example"]);
    return result;
  };
  const inv = f.ownTurn();
  assert.equal(await code(f.send({ to: ["bob@example.org"] }, inv)), "MAIL_REVOKED");
  assert.equal(f.smtp.messages.length, 0);
  assert.equal(f.count("Drafts"), 1);
  const [row] = f.workflows.store.list(f.id);
  assert.equal(row.state, "cancelled");
  assert.equal(row.diagnostic, "ACCESS_CHANGED");
});

test("saveSent without a Sent folder still sends and reports savedToSent false", async (t) => {
  const f = await sendFixture(t, { rules: ["example.org"] });
  f.imap.mailbox.folders.delete("Sent");
  const result = await f.send({ to: ["bob@example.org"] });
  assert.equal(result.status, "sent");
  assert.equal(result.savedToSent, false);
  assert.equal(f.smtp.messages.length, 1);
  assert.equal(f.count("Drafts"), 0);
});

test("a draft without plain text is MAIL_DRAFT_UNSUPPORTED", async (t) => {
  const f = await sendFixture(t, { rules: ["example.org"] });
  const { uid } = f.imap.mailbox.append("Drafts", {
    raw: Buffer.from(htmlOnly, "latin1"),
    flags: ["\\Draft"],
  });
  assert.equal(
    await code(f.mail({ action: "send", draftUid: uid })),
    "MAIL_DRAFT_UNSUPPORTED",
  );
  assert.equal(f.smtp.messages.length, 0);
});
