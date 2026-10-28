import test from "node:test";
import assert from "node:assert/strict";
import { mailFixture } from "../helpers/agent-mail-fixture.js";
import { waitFor } from "../helpers/agent-ssh-fixture.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";

// The channel fixture's owner speaks German (assistant-channel-fixture.js).
const m = serverCatalogs.de.mail;

/** A send grant without rules, the usual folders, and the paired Telegram chat. */
async function telegramFixture(t) {
  const f = await mailFixture(t);
  f.grant("send");
  f.imap.mailbox.add("Drafts", { specialUse: "\\Drafts" });
  f.imap.mailbox.add("Trash", { specialUse: "\\Trash" });
  f.imap.mailbox.add("Sent", { specialUse: "\\Sent" });
  f.workflows.mail.sends.pollMs = 10;
  f.workflows.mail.sends.holdMs = 30;
  const chat = {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: f.channel.chatId,
    userId: f.channel.userId,
  };
  const fields = {
    // A display name that looks like another address: the addr-spec decides.
    to: ['"bob@example.org" <eve@evil.net>'],
    cc: ["carol@example.org"],
    bcc: ["dana@example.net"],
    subject: "Offer",
    body: "Dear Bob,\nhere is the offer.\n```\nnot a fence end",
  };
  const send = (extra = {}) =>
    f.call(f.ownTurn(chat), {
      action: "send",
      accountId: f.account.id,
      ...fields,
      ...extra,
    });
  const entry = (phase, id) =>
    f.service.outbox.all().find((e) => e.key === `action-${phase}:${id}`);
  const decide = (id, decision, origin = chat) =>
    f.workflows.decide(id, { decision, revision: f.workflows.get(id).revision }, origin);
  return { ...f, chat, fields, send, entry, decide };
}

test("a Telegram owner turn's card shows every address, the mail in full and both buttons", async (t) => {
  const f = await telegramFixture(t);
  const { actionId } = await f.send();
  const approval = f.entry("approval", actionId);
  assert.ok(approval, "the card reaches the turn's chat");
  assert.equal(approval.chatId, f.channel.chatId);
  assert.equal(approval.source.actionId, actionId);
  assert.ok(approval.text.startsWith(m.mailApproval));
  for (const part of [
    "Private",
    "agent@example.com",
    "eve@evil.net",
    "carol@example.org",
    "dana@example.net",
    "Offer",
    "Dear Bob,\nhere is the offer.",
  ])
    assert.ok(approval.text.includes(part), part);
  // The spoofed name never stands alone where the address belongs.
  assert.match(approval.text, /eve@evil\.net.*bob@example\.org/);
  // A fence inside the body cannot end the block it is shown in.
  assert.doesNotMatch(approval.text, /^```\nnot a fence end/m);
  assert.equal(approval.text.includes(m.mailOpenToApprove), false);
  assert.deepEqual(
    approval.actions.map((a) => [a.decision, a.label, a.proposalId]),
    [
      ["approve", m.mailSend, actionId],
      ["decline", m.mailDecline, actionId],
    ],
  );
});

test("a body too long or with a hidden character gets no buttons and is not shown", async (t) => {
  const f = await telegramFixture(t);
  const long = await f.send({ body: "x".repeat(3001) });
  const hidden = await f.send({ body: "Pay to​ account 1" });
  const subject = await f.send({ subject: "Hi‍ there", body: "short" });
  for (const { actionId } of [long, hidden, subject]) {
    const approval = f.entry("approval", actionId);
    assert.deepEqual(approval.actions, []);
    assert.ok(approval.text.includes(m.mailOpenToApprove));
    assert.ok(approval.text.includes("eve@evil.net"));
  }
  assert.equal(f.entry("approval", long.actionId).text.includes("xxxxxxxxxx"), false);
  assert.equal(f.entry("approval", hidden.actionId).text.includes("account 1"), false);
  // A hidden character in a shown field appears as its code.
  const shown = f.entry("approval", subject.actionId).text;
  assert.ok(shown.includes("Hi<U+200D> there"));
  assert.equal(shown.includes("‍"), false);
});

test("Send from the bound chat sends once; another chat is refused; results omit the body", async (t) => {
  const f = await telegramFixture(t);
  const { actionId } = await f.send();
  const other = { ...f.chat, chatId: "999", userId: "999" };
  assert.equal((await f.decide(actionId, "approve", other).catch((e) => e)).status, 403);
  assert.equal(f.smtp.messages.length, 0);
  await f.decide(actionId, "approve");
  await waitFor(() => f.workflows.get(actionId).state === "completed");
  assert.equal((await f.decide(actionId, "approve").catch((e) => e)).status, 409);
  await f.workflows.tick();
  assert.equal(f.smtp.messages.length, 1);
  const result = f.entry("result", actionId);
  assert.ok(result.text.startsWith(m.mailStates.completed));
  assert.deepEqual(result.actions, []);
  assert.equal(result.text.includes("here is the offer"), false);
  // A declined card's result says the draft stays, again without the body.
  const second = await f.send({ body: "Second offer body" });
  await f.decide(second.actionId, "decline");
  await f.workflows.tick();
  const declined = f.entry("result", second.actionId);
  assert.ok(declined.text.startsWith(m.mailStates.declined));
  assert.equal(declined.text.includes("Second offer body"), false);
});

test("cancelled, failed and unknown outcomes reach the chat", async (t) => {
  const f = await telegramFixture(t);
  const cancelled = await f.send();
  f.grant("read");
  await f.workflows.tick();
  assert.ok(
    f.entry("result", cancelled.actionId).text.startsWith(m.mailStates.cancelled),
  );
  f.grant("send");
  const lost = await f.send();
  f.workflows.store.patch(lost.actionId, { state: "executing", followUp: false });
  await f.workflows.tick();
  assert.ok(f.entry("result", lost.actionId).text.startsWith(m.mailStates.unknown));
  const failed = await f.send();
  f.workflows.store.patch(failed.actionId, {
    state: "failed",
    result: { code: "MAIL_AUTH_FAILED" },
  });
  await f.workflows.tick();
  const text = f.entry("result", failed.actionId).text;
  assert.ok(text.startsWith(`${m.mailStates.failed} · MAIL_AUTH_FAILED`));
  assert.equal(text.includes("here is the offer"), false);
});
