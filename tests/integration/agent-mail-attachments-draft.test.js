import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { carries, code, sendFilesFixture } from "../helpers/mail-send-files-fixture.js";
import { pdfWith } from "../helpers/mail-documents.js";
import { MailDraftFiles } from "../../server/features/assistants/mail/agent-mail-draft-files.js";

const pdfType = "application/pdf";
const rows = (f) =>
  f.store.db
    .prepare("SELECT account_id,assistant_id,source FROM agent_mail_draft_files")
    .all()
    .map((row) => ({ ...row }));

test("a draft call with files shows their paths when sent later", async (t) => {
  const f = await sendFilesFixture(t);
  const bytes = pdfWith("Offer");
  fs.writeFileSync(f.ws("offer.pdf"), bytes);
  const d = await f.draft({ attachments: [{ path: "offer.pdf" }] });
  assert.deepEqual(d.attachments, [
    { name: "offer.pdf", size: bytes.length, type: pdfType },
  ]);
  // Only names, sizes and types reach the agent.
  assert.equal(d.htmlPart, undefined);
  assert.deepEqual(rows(f), [
    {
      account_id: f.account.id,
      assistant_id: f.id,
      source: JSON.stringify({ kind: "workspace", path: "offer.pdf" }),
    },
  ]);
  const r = await f.send({ draftUid: d.draftUid });
  assert.equal(r.status, "awaiting_approval");
  const p = f.workflows.get(r.actionId).payload;
  assert.deepEqual(p.attachments[0].source, { kind: "workspace", path: "offer.pdf" });
  assert.equal(p.files.context.assistantId, f.id);
  await f.decide(r.actionId);
  assert.equal((await f.settled(r.actionId)).state, "completed");
  assert.ok(carries(f.smtp.messages[0].raw, bytes));
});

test("updating a draft keeps attachments unless removed by name", async (t) => {
  const f = await sendFilesFixture(t);
  const pdf = pdfWith("A");
  fs.writeFileSync(f.ws("a.pdf"), pdf);
  fs.writeFileSync(f.ws("b.csv"), "x;y\n1;2\n");
  const first = await f.draft({ attachments: [{ path: "a.pdf" }, { path: "b.csv" }] });
  assert.deepEqual(
    first.attachments.map((a) => a.name),
    ["a.pdf", "b.csv"],
  );
  const second = await f.draft({
    draftUid: first.draftUid,
    removeAttachments: ["b.csv"],
  });
  assert.deepEqual(
    second.attachments.map((a) => a.name),
    ["a.pdf"],
  );
  assert.equal(second.replaced, true);
  assert.equal(f.count("Drafts"), 1);
  assert.equal(f.count("Trash"), 1);
  // The kept file still names its path when the new draft is sent.
  const r = await f.send({ draftUid: second.draftUid });
  const p = f.workflows.get(r.actionId).payload;
  assert.deepEqual(
    p.attachments.map((a) => [a.name, a.source]),
    [["a.pdf", { kind: "workspace", path: "a.pdf" }]],
  );
  // A third version adds a file after the kept one.
  fs.writeFileSync(f.ws("c.pdf"), pdfWith("C"));
  const third = await f.draft({
    draftUid: second.draftUid,
    attachments: [{ path: "c.pdf" }],
  });
  assert.deepEqual(
    third.attachments.map((a) => a.name),
    ["a.pdf", "c.pdf"],
  );
  const again = await f.send({ draftUid: third.draftUid });
  assert.deepEqual(
    f.workflows.get(again.actionId).payload.attachments.map((a) => a.source),
    [
      { kind: "workspace", path: "a.pdf" },
      { kind: "workspace", path: "c.pdf" },
    ],
  );
});

test("attachment input is checked before any file or mailbox is read", async (t) => {
  const f = await sendFilesFixture(t);
  fs.writeFileSync(f.ws("a.pdf"), pdfWith("A"));
  const many = Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.txt` }));
  for (const input of [
    // More than 20 files.
    { attachments: many },
    // The same file twice.
    { attachments: [{ path: "a.pdf" }, { path: "a.pdf" }] },
    // Control characters in a path or project id.
    { attachments: [{ path: "a\u0000.pdf" }] },
    { attachments: [{ path: "a\n.pdf" }] },
    { attachments: [{ path: "a.pdf", projectId: "p\u0007" }] },
    // A project id without a path.
    { attachments: [{ projectId: f.folderProject.id }] },
  ]) {
    assert.equal(await code(f.send(input)), "INVALID_INPUT", JSON.stringify(input));
    assert.equal(await code(f.draft(input)), "INVALID_INPUT", JSON.stringify(input));
  }
  // Removing attachments needs the draft they are in.
  assert.equal(await code(f.draft({ removeAttachments: ["a.pdf"] })), "INVALID_INPUT");
  assert.equal(
    await code(f.draft({ draftUid: 1, removeAttachments: ["a\u0001"] })),
    "INVALID_INPUT",
  );
  // A stored draft is sent as it is: no files on top.
  assert.equal(
    await code(f.send({ draftUid: 1, attachments: [{ path: "a.pdf" }] })),
    "INVALID_INPUT",
  );
  assert.equal(f.imap.mailbox.appended?.length ?? 0, 0);
  assert.equal(f.workflows.store.list(f.id).length, 0);
});

test("a replaced draft keeps at most 20 files together with the new ones", async (t) => {
  const f = await sendFilesFixture(t);
  const names = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
  for (const name of names) fs.writeFileSync(f.ws(name), `file ${name}`);
  const full = await f.draft({ attachments: names.map((path) => ({ path })) });
  assert.equal(full.attachments.length, 20);
  fs.writeFileSync(f.ws("extra.txt"), "extra");
  const appended = f.imap.mailbox.appended.length;
  assert.equal(
    await code(
      f.draft({ draftUid: full.draftUid, attachments: [{ path: "extra.txt" }] }),
    ),
    "INVALID_INPUT",
  );
  assert.equal(f.imap.mailbox.appended.length, appended);
  // Removing one makes room.
  const swapped = await f.draft({
    draftUid: full.draftUid,
    removeAttachments: ["f0.txt"],
    attachments: [{ path: "extra.txt" }],
  });
  assert.equal(swapped.attachments.length, 20);
  assert.equal(swapped.attachments.at(-1).name, "extra.txt");
});

test("a recorded source the agent lost is refused when the draft is sent", async (t) => {
  const f = await sendFilesFixture(t);
  const project = f.folderProject.id;
  f.grant({ projectFiles: { [project]: "read" } });
  f.file(f.proj("plan.pdf"), pdfWith("Plan"));
  const d = await f.draft({ attachments: [{ path: "plan.pdf", projectId: project }] });
  f.grant({ projectFiles: {} });
  assert.equal(await code(f.send({ draftUid: d.draftUid })), "MAIL_SOURCE_REFUSED");
  assert.equal(f.workflows.store.list(f.id).length, 0);
  // The draft stays where it is.
  assert.equal(f.count("Drafts"), 1);
});

test("removing the account removes its draft file sources", async (t) => {
  const f = await sendFilesFixture(t);
  fs.writeFileSync(f.ws("a.pdf"), pdfWith("A"));
  await f.draft({ attachments: [{ path: "a.pdf" }] });
  assert.equal(rows(f).length, 1);
  f.mailStore.remove(f.account.id, { role: "owner" });
  assert.deepEqual(rows(f), []);
});

test("draft file sources older than 30 days go on the next record", () => {
  const db = new DatabaseSync(":memory:");
  let now = Date.parse("2026-10-01T00:00:00Z");
  const files = new MailDraftFiles(db, () => now);
  const source = { kind: "workspace", path: "a.pdf" };
  const entry = (partSha256) => ({ partSha256, source, files: { shell: "off" } });
  files.record("acc", "<old@x>", "agent-1", [entry("p1")]);
  files.carry("acc", "<old@x>", "<new@x>", ["p1", "p2"]);
  assert.deepEqual([...files.lookup("acc", "<new@x>", "agent-1").keys()], ["p1"]);
  assert.equal(files.lookup("acc", "<new@x>", "agent-2").size, 0);
  now += 31 * 86400000;
  files.record("acc", "<later@x>", "agent-1", [entry("p3")]);
  assert.equal(files.lookup("acc", "<old@x>", "agent-1").size, 0);
  assert.equal(files.lookup("acc", "<new@x>", "agent-1").size, 0);
  assert.deepEqual(files.lookup("acc", "<later@x>", "agent-1").get("p3"), {
    source,
    files: { shell: "off" },
  });
  files.removeAccount("acc");
  assert.equal(files.lookup("acc", "<later@x>", "agent-1").size, 0);
});
