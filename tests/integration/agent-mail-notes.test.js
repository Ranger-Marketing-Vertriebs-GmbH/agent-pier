import test from "node:test";
import assert from "node:assert/strict";
import { actionNotes } from "../../server/features/assistants/assistant-action-notifications.js";
import { mailFixture } from "../helpers/agent-mail-fixture.js";
import { waitFor } from "../helpers/agent-ssh-fixture.js";

// Every card's final state leaves one `mail-run` note in the agent's chat, so an
// owner who decides on the web sees the outcome without the agent's word.

async function notesFixture(t) {
  const f = await mailFixture(t);
  f.grant("send");
  f.imap.mailbox.add("Drafts", { specialUse: "\\Drafts" });
  f.imap.mailbox.add("Trash", { specialUse: "\\Trash" });
  f.imap.mailbox.add("Sent", { specialUse: "\\Sent" });
  f.workflows.mail.sends.pollMs = 10;
  f.workflows.mail.sends.holdMs = 30;
  const send = (extra = {}) =>
    f.call(f.ownTurn(), {
      action: "send",
      accountId: f.account.id,
      to: ['"Bob" <bob@example.org>'],
      cc: ["carol@example.org"],
      bcc: ["dana@example.net"],
      subject: "Offer",
      body: "Secret body text",
      ...extra,
    });
  const decide = (id, decision) =>
    f.workflows.decide(
      id,
      { decision, revision: f.workflows.get(id).revision },
      { kind: "owner", channel: "ui" },
    );
  // What the chat history merges in (conversations.js withRunNotes); the mail
  // fixture's routine stub cannot build a whole history.
  const notes = async () =>
    actionNotes(f.workflows.store.list(f.id), f.channel.conversationId).filter(
      (m) => m.event === "mail-run",
    );
  return { ...f, send, decide, notes };
}

test("each final state leaves one note without body or addresses", async (t) => {
  const f = await notesFixture(t);
  const sent = await f.send();
  await f.decide(sent.actionId, "approve");
  await waitFor(() => f.workflows.get(sent.actionId).state === "completed");
  const declined = await f.send();
  await f.decide(declined.actionId, "decline");
  const expired = await f.send();
  f.workflows.store.patch(expired.actionId, { expiresAt: Date.now() - 1 });
  await f.workflows.tick();
  const cancelled = await f.send();
  const removedLater = await f.send();
  f.grant("read");
  await f.workflows.tick();
  f.grant("send");
  const lost = await f.send();
  f.workflows.store.patch(lost.actionId, { state: "executing", followUp: false });
  await f.workflows.tick();
  // A second tick writes no second note.
  await f.workflows.tick();
  const notes = await f.notes();
  const byId = new Map(notes.map((n) => [n.actionId, n]));
  assert.equal(notes.length, 6);
  assert.deepEqual(
    [sent, declined, expired, cancelled, removedLater, lost].map(
      (r) => byId.get(r.actionId)?.state,
    ),
    ["completed", "declined", "expired", "cancelled", "cancelled", "unknown"],
  );
  assert.deepEqual(byId.get(sent.actionId), {
    id: `mail-run:${sent.actionId}`,
    role: "event",
    event: "mail-run",
    actionId: sent.actionId,
    state: "completed",
    code: null,
    accountName: "Private",
    recipientCount: 3,
    subject: "Offer",
    timestamp: byId.get(sent.actionId).timestamp,
    runId: null,
  });
  assert.equal(byId.get(cancelled.actionId).code, "ACCESS_CHANGED");
  const text = JSON.stringify(notes);
  for (const secret of ["Secret body text", "bob@example.org", "carol@", "dana@", "Bob"])
    assert.equal(text.includes(secret), false, secret);
});

test("a failed send and a removed account are noted with their codes", async (t) => {
  const f = await notesFixture(t);
  // A refused login fails before the SMTP session: nothing went out.
  f.smtp.users["agent@example.com"] = "changed";
  const failed = await f.send();
  await f.decide(failed.actionId, "approve");
  await waitFor(() => f.workflows.get(failed.actionId).state === "failed");
  const removed = await f.send();
  f.mailStore.remove(f.account.id, { role: "owner" });
  const notes = await f.notes();
  const byId = new Map(notes.map((n) => [n.actionId, n]));
  assert.deepEqual(
    [byId.get(failed.actionId).state, byId.get(failed.actionId).code],
    ["failed", "MAIL_AUTH_FAILED"],
  );
  assert.deepEqual(
    [byId.get(removed.actionId).state, byId.get(removed.actionId).code],
    ["cancelled", "ACCOUNT_REMOVED"],
  );
});

test("a rule send leaves no note", async (t) => {
  const f = await notesFixture(t);
  f.grant("send", ["example.org", "example.net"]);
  assert.equal((await f.send()).status, "sent");
  assert.deepEqual(await f.notes(), []);
});
