import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  carries,
  code,
  sendFilesFixture,
  sha256,
} from "../helpers/mail-send-files-fixture.js";
import { mimeWith, pdfWith } from "../helpers/mail-documents.js";
import { contentDigest } from "../../server/features/assistants/mail/agent-mail-send-input.js";
import { attachmentLimits } from "../../server/features/mail/mail-parts.js";

const pdfType = "application/pdf";

test("a send with a workspace file raises a card with path, size, type and hash", async (t) => {
  const f = await sendFilesFixture(t);
  const bytes = pdfWith("Offer");
  fs.writeFileSync(f.ws("offer.pdf"), bytes);
  const r = await f.send({ attachments: [{ path: "offer.pdf" }] });
  assert.equal(r.status, "awaiting_approval");
  const p = f.workflows.get(r.actionId).payload;
  assert.equal(p.attachments.length, 1);
  const [a] = p.attachments;
  assert.deepEqual(a.source, { kind: "workspace", path: "offer.pdf" });
  assert.equal(a.sha256, sha256(fs.readFileSync(f.ws("offer.pdf"))));
  assert.equal(a.name, "offer.pdf");
  assert.equal(a.type, pdfType);
  assert.equal(a.size, bytes.length);
  assert.equal(a.part, "2");
  assert.match(a.partSha256, /^[0-9a-f]{64}$/);
  assert.equal(p.attachmentBytes, bytes.length);
  assert.equal(p.forward, null);
  assert.equal(p.html, null);
  assert.deepEqual(p.files.context.assistantId, f.id);
  assert.equal(p.files.shell, "off");
  // The file sits in the saved draft, and nothing went out yet.
  assert.equal(f.count("Drafts"), 1);
  assert.ok(carries(f.imap.folder("Drafts").messages[0].raw, bytes));
  assert.equal(f.smtp.messages.length, 0);
});

test("approving sends exactly the captured bytes even if the file changed", async (t) => {
  const f = await sendFilesFixture(t);
  const original = pdfWith("Offer 100");
  const changed = pdfWith("Offer 999");
  fs.writeFileSync(f.ws("offer.pdf"), original);
  const r = await f.send({ attachments: [{ path: "offer.pdf" }] });
  fs.writeFileSync(f.ws("offer.pdf"), changed);
  await f.decide(r.actionId);
  const row = await f.settled(r.actionId);
  assert.equal(row.state, "completed");
  assert.equal(f.smtp.messages.length, 1);
  const raw = f.smtp.messages[0].raw;
  assert.ok(carries(raw, original));
  assert.equal(carries(raw, changed), false);
  assert.match(raw.toString("utf8"), /filename=offer\.pdf|filename="offer\.pdf"/);
  // The Sent copy carries it too; the draft went to Trash.
  assert.ok(carries(f.imap.folder("Sent").messages[0].raw, original));
  assert.equal(f.count("Drafts"), 0);
  const [audit] = f.sent();
  assert.equal(audit.details.attachments, 1);
  assert.equal(audit.details.attachmentBytes, original.length);
});

test("a draft changed in the mailbox fails with MAIL_DRAFT_CHANGED and sends nothing", async (t) => {
  const f = await sendFilesFixture(t);
  fs.writeFileSync(f.ws("offer.pdf"), pdfWith("Offer"));
  const r = await f.send({ attachments: [{ path: "offer.pdf" }] });
  // Someone swaps the attachment under the same UID.
  const [message] = f.imap.folder("Drafts").messages;
  message.raw = Buffer.from(
    mimeWith({
      text: "See attached.",
      attachments: [{ name: "offer.pdf", type: pdfType, content: pdfWith("Other") }],
    }),
    "latin1",
  );
  delete message.parsed;
  await f.decide(r.actionId);
  const row = await f.settled(r.actionId);
  assert.equal(row.state, "failed");
  assert.equal(row.result.code, "MAIL_DRAFT_CHANGED");
  assert.equal(f.smtp.messages.length, 0);
  // The draft stays for the owner.
  assert.equal(f.count("Drafts"), 1);
  const [audit] = f.sent();
  assert.equal(audit.details.delivery, "failed");
  assert.equal(audit.details.code, "MAIL_DRAFT_CHANGED");
});

test("a revoked project or lowered shell cancels the card at approval", async (t) => {
  const f = await sendFilesFixture(t);
  const project = f.folderProject.id;
  f.grant({ projectFiles: { [project]: "read" } });
  f.file(f.proj("plan.pdf"), pdfWith("Plan"));
  const fromProject = await f.send({
    attachments: [{ path: "plan.pdf", projectId: project }],
  });
  const card = f.workflows.get(fromProject.actionId).payload.attachments[0];
  assert.deepEqual(card.source, {
    kind: "project",
    projectId: project,
    projectName: f.folderProject.name,
    path: "plan.pdf",
  });
  f.grant({ projectFiles: {} });
  const cancelled = await f.decide(fromProject.actionId);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.diagnostic, "ACCESS_CHANGED");

  // A host file read with Full access, then the shell is lowered.
  f.grant({ shell: "full" });
  const host = f.file(path.join(f.base, "host.pdf"), pdfWith("Host"));
  const fromHost = await f.send({ attachments: [{ path: host }] });
  assert.deepEqual(f.workflows.get(fromHost.actionId).payload.attachments[0].source, {
    kind: "host",
    path: host,
  });
  f.grant({ shell: "approval" });
  const lowered = await f.decide(fromHost.actionId);
  assert.equal(lowered.state, "cancelled");
  assert.equal(lowered.diagnostic, "ACCESS_CHANGED");
  assert.equal(f.smtp.messages.length, 0);
});

test("recipient rules send attachments without a card", async (t) => {
  const f = await sendFilesFixture(t, { rules: ["example.org"] });
  const bytes = pdfWith("Rechnung");
  fs.writeFileSync(f.ws("Rechnung-Mueller.pdf"), bytes);
  const r = await f.send({ attachments: [{ path: "Rechnung-Mueller.pdf" }] });
  assert.equal(r.status, "sent");
  assert.equal(f.smtp.messages.length, 1);
  assert.ok(carries(f.smtp.messages[0].raw, bytes));
  const [audit] = f.sent();
  assert.deepEqual(audit.details, {
    kind: "message",
    assistantId: f.id,
    actionId: r.actionId,
    authorizedBy: "rule",
    recipients: 1,
    delivery: "sent",
    attachments: 1,
    attachmentBytes: bytes.length,
  });
  // No name, path or content in the audit.
  const log = JSON.stringify(f.audit);
  for (const text of [
    "Rechnung",
    "Mueller",
    ".pdf",
    bytes.toString("base64").slice(0, 40),
  ])
    assert.equal(log.includes(text), false, text);
});

test("an owner-made Gmail draft with HTML and an attachment can be sent", async (t) => {
  const f = await sendFilesFixture(t);
  const pdf = pdfWith("Attached");
  const { uid } = f.imap.mailbox.append("Drafts", {
    raw: Buffer.from(
      mimeWith({
        text: "Plain hello.",
        html: "<p>Styled hello.</p>",
        attachments: [{ name: "a.pdf", type: pdfType, content: pdf }],
      }),
      "latin1",
    ),
    flags: ["\\Draft"],
  });
  const r = await f.send({ draftUid: uid });
  assert.equal(r.status, "awaiting_approval");
  const p = f.workflows.get(r.actionId).payload;
  assert.equal(p.attachments.length, 1);
  assert.deepEqual(p.attachments[0].source, { kind: "draft" });
  assert.equal(p.attachments[0].name, "a.pdf");
  assert.equal(p.attachments[0].sha256, sha256(pdf));
  assert.equal(p.files, null);
  await f.decide(r.actionId);
  assert.equal((await f.settled(r.actionId)).state, "completed");
  const raw = f.smtp.messages[0].raw.toString("utf8");
  assert.match(raw, /Content-Type: text\/plain/);
  assert.match(raw, /Plain hello\./);
  assert.match(raw, /a\.pdf/);
  assert.ok(carries(f.smtp.messages[0].raw, pdf));
  assert.doesNotMatch(raw, /text\/html/);
  assert.doesNotMatch(raw, /Styled hello/);
});

test("more than 25 MB in one send is refused before a draft is saved", async (t) => {
  const f = await sendFilesFixture(t);
  f.workflows.mail.limits.attachments = { ...attachmentLimits, mailBytes: 1000 };
  fs.writeFileSync(f.ws("a.bin"), Buffer.alloc(600, 1));
  fs.writeFileSync(f.ws("b.bin"), Buffer.alloc(600, 2));
  assert.equal(
    await code(f.send({ attachments: [{ path: "a.bin" }, { path: "b.bin" }] })),
    "MAIL_ATTACHMENT_TOO_LARGE",
  );
  assert.equal(
    await code(f.draft({ attachments: [{ path: "a.bin" }, { path: "b.bin" }] })),
    "MAIL_ATTACHMENT_TOO_LARGE",
  );
  assert.equal(f.count("Drafts"), 0);
  assert.equal(f.imap.mailbox.appended?.length ?? 0, 0);
  assert.equal(f.smtp.messages.length, 0);
  assert.equal(f.workflows.store.list(f.id).length, 0);
});

test("an open step-1 card without attachments still verifies", async (t) => {
  const f = await sendFilesFixture(t);
  const r = await f.send();
  const p = f.workflows.get(r.actionId).payload;
  const step1 = createHash("sha256")
    .update(
      JSON.stringify([
        p.accountId,
        p.from,
        p.to,
        p.cc,
        p.bcc,
        p.subject,
        p.body,
        p.inReplyTo,
        p.references,
        p.draftMessageId,
        p.draftUid,
      ]),
      "utf8",
    )
    .digest("hex");
  assert.equal(p.contentSha256, step1);
  // A card stored by step 1 has none of the new fields.
  const {
    attachments: _a,
    attachmentBytes: _b,
    files: _f,
    html: _h,
    forward: _w,
    ...old
  } = p;
  assert.equal(contentDigest(old), step1);
  // Attachments added to a stored card no longer match its digest.
  const tampered = {
    ...p,
    attachments: [{ part: "2", partSha256: "0".repeat(64), source: { kind: "draft" } }],
  };
  assert.notEqual(contentDigest(tampered), step1);
  await f.decide(r.actionId);
  assert.equal((await f.settled(r.actionId)).state, "completed");
});

test("the browser's card carries no file access context", async (t) => {
  const f = await sendFilesFixture(t);
  fs.writeFileSync(f.ws("offer.pdf"), pdfWith("Offer"));
  const r = await f.send({ attachments: [{ path: "offer.pdf" }] });
  // Stored for the approval's re-check, never shown.
  assert.ok(f.workflows.get(r.actionId).payload.files);
  const listed = f.workflows.list(f.id, { delegated: true }).actions;
  const card = listed.find((a) => a.id === r.actionId);
  assert.equal("files" in card.payload, false);
  assert.equal(card.payload.attachments[0].name, "offer.pdf");
  assert.equal("files" in f.workflows.pending(f.id)[0].payload, false);
  const decided = await f.decide(r.actionId, "decline");
  assert.equal("files" in decided.payload, false);
  // The stored row keeps it.
  assert.ok(f.workflows.get(r.actionId).payload.files);
});

test("a stored draft over the limit once fetched is refused before a card", async (t) => {
  const f = await sendFilesFixture(t);
  const pdf = Buffer.concat([pdfWith("Big"), Buffer.alloc(4000, 7)]);
  const raw = mimeWith({
    text: "Hello.",
    attachments: [{ name: "a.pdf", type: pdfType, content: pdf }],
  });
  const { uid } = f.imap.mailbox.append("Drafts", {
    raw: Buffer.from(raw, "latin1"),
    flags: ["\\Draft"],
  });
  // The lower bound BODYSTRUCTURE gives fits the limit; the decoded bytes do not.
  const encoded = raw.match(/filename="a\.pdf"\r\n[^\r]*\r\n\r\n([^]*?)\r\n--mix--/)[1];
  const atLeast = Math.floor((Math.floor((encoded.length * 3) / 4) * 64) / 66);
  const limit = pdf.length - 1;
  assert.ok(atLeast <= limit);
  f.workflows.mail.limits.attachments = { ...attachmentLimits, mailBytes: limit };
  assert.equal(await code(f.send({ draftUid: uid })), "MAIL_ATTACHMENT_TOO_LARGE");
  assert.equal(f.workflows.mail.sends.hourSends(f.id), 0);
  assert.equal(f.count("Drafts"), 1);
  assert.equal(f.smtp.messages.length, 0);
  f.workflows.mail.limits.attachments = { ...attachmentLimits, mailBytes: pdf.length };
  assert.equal((await f.send({ draftUid: uid })).status, "awaiting_approval");
});

test("a send refused at its last limit check records no file sources", async (t) => {
  const f = await sendFilesFixture(t);
  fs.writeFileSync(f.ws("offer.pdf"), pdfWith("Offer"));
  const sources = () =>
    f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_mail_draft_files").get().n;
  // The hourly cap is reached while the draft is saved: the check before the row
  // refuses the send.
  const sends = f.workflows.mail.sends;
  const limit = sends.limit.bind(sends);
  let checks = 0;
  sends.limit = (inv, caller, permit) => {
    if (++checks === 2) throw sends.refuse(inv, caller, "mailSendLimit");
    return limit(inv, caller, permit);
  };
  assert.equal(
    await code(f.send({ attachments: [{ path: "offer.pdf" }] })),
    "MAIL_SEND_LIMIT",
  );
  assert.equal(sources(), 0);
  // The saved draft went to Trash again.
  assert.equal(f.count("Drafts"), 0);
  // A send that gets its row records them.
  checks = 2;
  const r = await f.send({ attachments: [{ path: "offer.pdf" }] });
  assert.equal(r.status, "awaiting_approval");
  assert.equal(sources(), 1);
});
