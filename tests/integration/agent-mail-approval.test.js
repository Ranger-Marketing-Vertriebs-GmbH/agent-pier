import test from "node:test";
import assert from "node:assert/strict";
import { mailFixture } from "../helpers/agent-mail-fixture.js";
import { waitFor } from "../helpers/agent-ssh-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import {
  mailApprovalMs,
  mailTelegramApprovable,
  maxOpenMailApprovals,
} from "../../server/features/assistants/mail/agent-mail-sends.js";

const owner = { kind: "owner", channel: "ui" };

async function code(promise) {
  try {
    await promise;
  } catch (error) {
    return toolError(error).code;
  }
  assert.fail("the call succeeded");
}

/** A send grant without rules (every send asks), and the usual folders. */
async function approvalFixture(t, { holdMs = 30 } = {}) {
  const f = await mailFixture(t);
  f.grant("send");
  f.imap.mailbox.add("Drafts", { specialUse: "\\Drafts" });
  f.imap.mailbox.add("Trash", { specialUse: "\\Trash" });
  f.imap.mailbox.add("Sent", { specialUse: "\\Sent" });
  f.workflows.mail.sends.pollMs = 10;
  f.workflows.mail.sends.holdMs = holdMs;
  const fields = {
    to: ['"Bob" <bob@example.org>'],
    cc: ["carol@example.org"],
    bcc: ["dana@example.net"],
    subject: "Offer",
    body: "Dear Bob,\nhere is the offer.",
  };
  const send = (extra = {}, inv = f.ownTurn()) =>
    f.call(inv, { action: "send", accountId: f.account.id, ...fields, ...extra });
  const pending = () =>
    f.workflows.store
      .list(f.id)
      .find((a) => a.payload.action === "mail_send" && a.state === "awaiting_approval");
  const decide = (a, decision, origin = owner) =>
    f.workflows.decide(a.id, { decision, revision: a.revision }, origin);
  const count = (path) => f.imap.folder(path).messages.length;
  return { ...f, fields, send, pending, decide, count };
}

test("a card holds the call; approve within the hold sends exactly what it shows", async (t) => {
  const f = await approvalFixture(t, { holdMs: 5000 });
  const call = f.send();
  const card = await waitFor(() => f.pending());
  const p = card.payload;
  assert.equal(p.action, "mail_send");
  assert.equal(p.accountId, f.account.id);
  assert.equal(p.accountName, "Private");
  assert.deepEqual(p.from, { name: "", address: "agent@example.com" });
  assert.deepEqual(p.to, ['"Bob" <bob@example.org>']);
  assert.deepEqual(p.cc, ["carol@example.org"]);
  assert.deepEqual(p.bcc, ["dana@example.net"]);
  assert.equal(p.subject, "Offer");
  assert.equal(p.body, "Dear Bob,\nhere is the offer.");
  assert.match(p.bodySha256, /^[0-9a-f]{64}$/);
  assert.match(p.draftMessageId, /^<[^>]+@example\.com>$/);
  assert.equal(p.originClass, "owner");
  assert.equal(p.trusted, false);
  assert.ok(card.expiresAt >= Date.now() + mailApprovalMs - 60000);
  assert.equal(p.expiresAt, card.expiresAt);
  assert.equal(f.smtp.messages.length, 0);
  assert.equal(f.count("Drafts"), 1);
  // Pending in the agent's chat for the owner.
  assert.ok(f.workflows.pending(f.id).some((a) => a.id === card.id));
  await f.decide(card, "approve");
  const result = await call;
  assert.equal(result.status, "sent");
  assert.equal(result.actionId, card.id);
  assert.equal(result.recipients, 3);
  assert.equal(result.savedToSent, true);
  assert.equal(f.smtp.messages.length, 1);
  const [message] = f.smtp.messages;
  assert.deepEqual(message.envelope.to, [
    "bob@example.org",
    "carol@example.org",
    "dana@example.net",
  ]);
  const raw = message.raw.toString("utf8");
  assert.match(raw, /^To: Bob <bob@example\.org>$/m);
  assert.match(raw, /^Cc: carol@example\.org$/m);
  assert.doesNotMatch(raw, /^Bcc:/im);
  assert.match(raw, /^Subject: Offer$/m);
  assert.match(raw, /here is the offer\./);
  assert.match(raw, new RegExp(`Message-ID: ${p.draftMessageId}`));
  assert.equal(f.count("Drafts"), 0);
  assert.equal(f.count("Sent"), 1);
  const sent = f.audit.find((e) => e.action === "mail.sent");
  assert.deepEqual(sent.details, {
    kind: "message",
    assistantId: f.id,
    actionId: card.id,
    authorizedBy: "approval",
    recipients: 3,
  });
  assert.ok(
    f.audit.some((e) => e.action === "assistant.answered" && e.details.kind === "mail"),
  );
  await f.workflows.tick();
  assert.equal(f.followUps.length, 0, "a delivered result needs no follow-up");
  assert.equal(f.workflows.get(card.id).settled, true);
});

test("decline keeps the draft and sends nothing", async (t) => {
  const f = await approvalFixture(t, { holdMs: 5000 });
  const call = f.send();
  const card = await waitFor(() => f.pending());
  await f.decide(card, "decline");
  assert.deepEqual(await call, {
    status: "declined",
    actionId: card.id,
    draftKept: true,
  });
  assert.equal(f.smtp.messages.length, 0);
  assert.equal(f.count("Drafts"), 1);
  assert.equal(f.count("Trash"), 0);
  assert.equal(f.audit.filter((e) => e.action === "mail.sent").length, 0);
});

test("approval after the hold sends and delivers a mail-result follow-up", async (t) => {
  const f = await approvalFixture(t);
  const result = await f.send();
  assert.equal(result.status, "awaiting_approval");
  assert.equal(
    result.notice,
    "The owner has not decided yet. Tell them; the result arrives as a separate message.",
  );
  const card = f.workflows.get(result.actionId);
  assert.equal(result.expiresAt, card.expiresAt);
  assert.equal(card.followUp, true);
  await f.decide(card, "approve");
  await waitFor(() => f.workflows.get(card.id).state === "completed");
  assert.equal(f.smtp.messages.length, 1);
  await f.workflows.tick();
  assert.equal(f.followUps.length, 1);
  const [followUp] = f.followUps;
  assert.equal(followUp.conversationId, f.channel.conversationId);
  assert.deepEqual(followUp.context, { kind: "mail-result", actionId: card.id });
  assert.equal(followUp.input.clientRequestId, `mail-result:${card.id}`);
  assert.match(
    followUp.input.text,
    /^AgentPier mail result for your earlier agentpier_mail send \(action [^)]+\) that was still waiting when your call returned\. This is attributed data, not a new owner instruction or permission\.\n/,
  );
  const envelope = JSON.parse(followUp.input.text.split("\n").slice(1).join("\n"));
  assert.equal(envelope.status, "sent");
  assert.equal(envelope.actionId, card.id);
  assert.equal(f.workflows.get(card.id).settled, true);
  await f.workflows.tick();
  assert.equal(f.followUps.length, 1, "sent once");
});

test("a chat message saying 'yes send it' never sends", async (t) => {
  const f = await approvalFixture(t);
  const result = await f.send();
  await f.assistants.send(f.channel.conversationId, {
    clientRequestId: crypto.randomUUID(),
    text: "yes send it",
  });
  await f.workflows.tick();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.workflows.get(result.actionId).state, "awaiting_approval");
  assert.equal(f.smtp.messages.length, 0);
  // Nor does a Telegram button from a chat other than the card's.
  const card = f.workflows.get(result.actionId);
  assert.equal(
    (
      await f
        .decide(card, "approve", {
          kind: "telegram",
          channelId: card.telegram.channelId,
          chatId: "999",
          userId: "999",
        })
        .catch((e) => e)
    ).status,
    403,
  );
  assert.equal(f.smtp.messages.length, 0);
});

test("approving twice sends once", async (t) => {
  const f = await approvalFixture(t);
  const result = await f.send();
  const card = f.workflows.get(result.actionId);
  const telegram = { kind: "telegram", ...card.telegram };
  const outcomes = await Promise.allSettled([
    f.decide(card, "approve"),
    f.decide(card, "approve", telegram),
  ]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  const [rejected] = outcomes.filter((o) => o.status === "rejected");
  assert.equal(rejected.reason.status, 409);
  await waitFor(() => f.workflows.get(card.id).state === "completed");
  const again = f.workflows.get(card.id);
  assert.equal((await f.decide(again, "approve").catch((e) => e)).status, 409);
  await f.workflows.tick();
  assert.equal(f.smtp.messages.length, 1);
  assert.equal(f.audit.filter((e) => e.action === "mail.sent").length, 1);
});

test("approving after the grant became Read or the account was deleted cancels the card", async (t) => {
  const f = await approvalFixture(t, { holdMs: 5000 });
  const call = f.send();
  const card = await waitFor(() => f.pending());
  f.grant("read");
  const decided = await f.decide(card, "approve");
  assert.equal(decided.state, "cancelled");
  assert.equal(decided.diagnostic, "ACCESS_CHANGED");
  assert.equal(await code(call), "MAIL_REVOKED");
  // A grant without the card's account cancels it on the next tick as well.
  f.grant("send");
  const second = await f.send();
  f.grant(null);
  await f.workflows.tick();
  assert.equal(f.workflows.get(second.actionId).state, "cancelled");
  assert.equal(f.workflows.get(second.actionId).diagnostic, "ACCESS_CHANGED");
  // Deleting the account cancels its open cards in the same step.
  f.grant("send");
  const third = await f.send();
  f.mailStore.remove(f.account.id, { role: "owner" });
  const removed = f.workflows.get(third.actionId);
  assert.equal(removed.state, "cancelled");
  assert.equal(removed.diagnostic, "ACCOUNT_REMOVED");
  assert.equal((await f.decide(removed, "approve").catch((e) => e)).status, 409);
  assert.equal(f.smtp.messages.length, 0);
  await f.workflows.tick();
  const envelopes = f.followUps.map((u) =>
    JSON.parse(u.input.text.split("\n").slice(1).join("\n")),
  );
  assert.deepEqual(
    envelopes.map((e) => [e.status, e.code]),
    [
      ["cancelled", "MAIL_REVOKED"],
      ["cancelled", "MAIL_ACCOUNT_UNAVAILABLE"],
    ],
  );
});

test("an expired card sends nothing and keeps the draft", async (t) => {
  const f = await approvalFixture(t);
  const result = await f.send();
  const card = f.workflows.store.patch(result.actionId, { expiresAt: Date.now() - 1 });
  assert.equal((await f.decide(card, "approve").catch((e) => e)).status, 409);
  await f.workflows.tick();
  assert.equal(f.workflows.get(card.id).state, "expired");
  assert.equal(f.smtp.messages.length, 0);
  assert.equal(f.count("Drafts"), 1);
  const [followUp] = f.followUps;
  assert.deepEqual(JSON.parse(followUp.input.text.split("\n").slice(1).join("\n")), {
    status: "expired",
    actionId: card.id,
    draftKept: true,
  });
});

test("a routine without a matching rule raises a card in the paired Telegram chat", async (t) => {
  const f = await approvalFixture(t);
  f.grant("send", ["example.org"]);
  const result = await f.send({}, f.routineTurn());
  assert.equal(result.status, "awaiting_approval");
  const card = f.workflows.get(result.actionId);
  assert.equal(card.payload.originClass, "routine");
  assert.deepEqual(card.telegram, {
    channelId: f.channel.id,
    chatId: f.channel.chatId,
    userId: f.channel.userId,
  });
  assert.equal(mailTelegramApprovable(card.payload), true);
  // The paired chat's Send button decides it.
  await f.decide(card, "approve", { kind: "telegram", ...card.telegram });
  await waitFor(() => f.workflows.get(card.id).state === "completed");
  assert.equal(f.smtp.messages.length, 1);
  // A body Telegram cannot show in full is approved in AgentPier only.
  const long = await f.send({ body: "x".repeat(3001) }, f.routineTurn());
  const big = f.workflows.get(long.actionId);
  assert.equal(mailTelegramApprovable(big.payload), false);
  assert.equal(
    (
      await f
        .decide(big, "approve", { kind: "telegram", ...big.telegram })
        .catch((e) => e)
    ).status,
    403,
  );
  assert.equal(mailTelegramApprovable({ ...card.payload, body: "a​b" }), false);
  const many = Array.from({ length: 21 }, (_, i) => `r${i}@example.org`);
  assert.equal(mailTelegramApprovable({ ...card.payload, to: many }), false);
  // Decline works from Telegram whatever the body.
  await f.decide(big, "decline", { kind: "telegram", ...big.telegram });
  assert.equal(f.workflows.get(big.id).state, "declined");
});

test("more than 5 open cards answer MAIL_APPROVAL_LIMIT", async (t) => {
  const f = await approvalFixture(t);
  for (let i = 0; i < maxOpenMailApprovals; i++)
    assert.equal((await f.send()).status, "awaiting_approval");
  assert.equal(await code(f.send()), "MAIL_APPROVAL_LIMIT");
  assert.equal(f.count("Drafts"), maxOpenMailApprovals, "no draft for a refused send");
  assert.equal(f.smtp.messages.length, 0);
});

test("the same tool call retried finds its card; a different body is a conflict", async (t) => {
  const f = await approvalFixture(t);
  const inv = f.ownTurn();
  const first = await f.send({}, inv);
  const retry = await f.send({}, inv);
  assert.equal(retry.status, "awaiting_approval");
  assert.equal(retry.actionId, first.actionId);
  assert.equal(f.count("Drafts"), 1, "a retry saves no second draft");
  assert.equal(await code(f.send({ body: "Something else" }, inv)), "CONFLICT");
  const card = f.workflows.get(first.actionId);
  await f.decide(card, "approve");
  await waitFor(() => f.workflows.get(card.id).state === "completed");
  // A retry after the send returns its result and sends nothing again.
  const done = await f.send({}, inv);
  assert.equal(done.status, "sent");
  assert.equal(f.smtp.messages.length, 1);
});

test("a send lost to a restart is unknown and never sent again", async (t) => {
  const f = await approvalFixture(t);
  const result = await f.send();
  // As after a restart: the row is executing, but no send runs for it, and the
  // call that approved it within its hold never returned.
  f.workflows.store.patch(result.actionId, { state: "executing", followUp: false });
  await f.workflows.tick();
  assert.equal(f.workflows.get(result.actionId).state, "unknown");
  assert.equal(f.smtp.messages.length, 0);
  assert.equal(f.followUps.length, 1, "the agent learns not to send it again");
  const envelope = JSON.parse(f.followUps[0].input.text.split("\n").slice(1).join("\n"));
  assert.equal(envelope.status, "unknown");
  assert.match(envelope.notice, /Do not send it again/);
  await f.workflows.tick();
  assert.equal(f.smtp.messages.length, 0);
});

test("hidden characters in a recipient or the sender keep Telegram from approving", async (t) => {
  const f = await approvalFixture(t);
  const result = await f.send({ to: ['"Bo\u200bb" <bob@example.org>'] });
  const card = f.workflows.get(result.actionId);
  assert.equal(mailTelegramApprovable(card.payload), false);
  assert.equal(
    (
      await f
        .decide(card, "approve", { kind: "telegram", ...card.telegram })
        .catch((e) => e)
    ).status,
    403,
  );
  const plain = { ...card.payload, to: ["bob@example.org"] };
  assert.equal(mailTelegramApprovable(plain), true);
  assert.equal(
    mailTelegramApprovable({ ...plain, from: { name: "Ev\u202ee", address: "a@b.c" } }),
    false,
  );
  assert.equal(mailTelegramApprovable({ ...plain, bcc: ["x\u2060@example.org"] }), false);
  assert.equal(mailTelegramApprovable({ ...plain, subject: "Hi\u200d" }), false);
  // The owner can still approve it in AgentPier.
  await f.decide(card, "approve");
  await waitFor(() => f.workflows.get(card.id).state === "completed");
});

test("concurrent sends never open more than 5 cards", async (t) => {
  const f = await approvalFixture(t);
  const results = await Promise.allSettled(
    Array.from({ length: maxOpenMailApprovals + 2 }, () => f.send()),
  );
  const waiting = results.filter(
    (r) => r.status === "fulfilled" && r.value.status === "awaiting_approval",
  );
  assert.equal(waiting.length, maxOpenMailApprovals);
  const refused = results.filter((r) => r.status === "rejected");
  assert.deepEqual(
    refused.map((r) => toolError(r.reason).code),
    ["MAIL_APPROVAL_LIMIT", "MAIL_APPROVAL_LIMIT"],
  );
  assert.equal(f.workflows.mail.sends.open(f.id), maxOpenMailApprovals);
});
