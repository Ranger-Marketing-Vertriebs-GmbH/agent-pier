import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mailFixture } from "../helpers/agent-mail-fixture.js";
import { mimeWith, pdfWith } from "../helpers/mail-documents.js";
import { saveDraft } from "../../server/features/mail/mail-changes.js";
import { loadDraft, loadDraftParts } from "../../server/features/mail/mail-drafts.js";
import {
  attachmentBytes,
  fetchRawParts,
  messageParts,
} from "../../server/features/mail/mail-parts.js";
import { openFolder } from "../../server/features/mail/mail-folders.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sender = { address: "agent@example.com", displayName: "Agent" };
const fields = {
  to: ["bob@example.org"],
  cc: [],
  bcc: [],
  subject: "Offer",
  body: "See attached.",
};
const pdf = (text) => ({
  filename: "a.pdf",
  content: pdfWith(text),
  contentType: "application/pdf",
});
const csv = {
  filename: "b.csv",
  content: Buffer.from("a;b\n1;2\n"),
  contentType: "text/csv",
};

async function partsFixture(t) {
  const f = await mailFixture(t);
  f.imap.mailbox.add("Drafts", { specialUse: "\\Drafts" });
  f.imap.mailbox.add("Trash", { specialUse: "\\Trash" });
  const run = (fn) => f.mailStore.withImap(f.account.id, fn);
  const drafts = () => f.imap.folder("Drafts").messages;
  return { ...f, run, drafts };
}

async function code(promise) {
  try {
    await promise;
  } catch (error) {
    return error.code;
  }
  assert.fail("the call succeeded");
}

test("a draft stores files and reads them back with digests", async (t) => {
  const f = await partsFixture(t);
  const file = pdf("49.99");
  const saved = await f.run((c) => saveDraft(c, sender, fields, { files: [file] }));
  assert.equal(saved.attachments.length, 1);
  const [a] = saved.attachments;
  assert.equal(a.name, "a.pdf");
  assert.equal(a.type, "application/pdf");
  assert.equal(a.size, file.content.length);
  assert.equal(a.sha256, sha256(file.content));
  assert.match(a.partSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(a.partSha256, a.sha256);
  assert.equal(typeof a.part, "string");
  assert.equal(saved.htmlPart, null);
  const loaded = await f.run((c) => loadDraft(c, saved.draftUid));
  assert.deepEqual(loaded.attachments, saved.attachments);
  assert.equal(loaded.fields.body, "See attached.");
  // The stored part is exactly what loadDraftParts hands back.
  const [raw] = await f.run((c) => loadDraftParts(c, saved.draftUid, saved.attachments));
  assert.equal(sha256(raw), a.partSha256);
  assert.ok(f.drafts()[0].raw.includes(raw));
});

test("files, raw parts and kept parts keep their order; html is read back", async (t) => {
  const f = await partsFixture(t);
  const first = await f.run((c) =>
    saveDraft(c, sender, fields, { files: [pdf("kept")] }),
  );
  const rawPart = Buffer.from(
    'Content-Type: text/plain; charset=ISO-8859-1; name="note.txt"\r\nContent-Disposition: attachment; filename="note.txt"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nGr=FC=DFe',
  );
  const second = await f.run((c) =>
    saveDraft(c, sender, fields, {
      replaceUid: first.draftUid,
      rawParts: [rawPart],
      files: [csv],
      html: "<p>See <b>attached</b>.</p>",
    }),
  );
  assert.deepEqual(
    second.attachments.map((a) => a.name),
    ["a.pdf", "note.txt", "b.csv"],
  );
  assert.equal(second.attachments[0].partSha256, first.attachments[0].partSha256);
  assert.equal(second.attachments[1].partSha256, sha256(rawPart));
  assert.equal(second.attachments[1].sha256, sha256(Buffer.from("Grüße", "latin1")));
  assert.equal(second.replaced, true);
  assert.ok(second.htmlPart);
  const [html] = await f.run((c) =>
    loadDraftParts(c, second.draftUid, [second.htmlPart]),
  );
  assert.match(html.toString(), /^Content-Type: text\/html/);
  assert.match(html.toString(), /<b>attached<\/b>/);
});

test("replacing a draft keeps its attachments unless removed by name", async (t) => {
  const f = await partsFixture(t);
  const first = await f.run((c) =>
    saveDraft(c, sender, fields, { files: [pdf("49.99"), csv] }),
  );
  assert.deepEqual(
    first.attachments.map((a) => a.name),
    ["a.pdf", "b.csv"],
  );
  const second = await f.run((c) =>
    saveDraft(
      c,
      sender,
      { ...fields, subject: "V2" },
      {
        replaceUid: first.draftUid,
        removeNames: ["b.csv"],
      },
    ),
  );
  assert.deepEqual(
    second.attachments.map((a) => a.name),
    ["a.pdf"],
  );
  assert.equal(second.attachments[0].partSha256, first.attachments[0].partSha256);
  assert.equal(second.attachments[0].sha256, first.attachments[0].sha256);
  assert.equal(second.replaced, true);
  assert.equal(f.drafts().length, 1);
  assert.equal(f.imap.folder("Trash").messages.length, 1);
  // A name only matches exactly; without replaceUid removeNames is refused.
  const third = await f.run((c) =>
    saveDraft(c, sender, fields, { replaceUid: second.draftUid, removeNames: ["A.PDF"] }),
  );
  assert.deepEqual(
    third.attachments.map((a) => a.name),
    ["a.pdf"],
  );
  await assert.rejects(
    f.run((c) => saveDraft(c, sender, fields, { removeNames: ["a.pdf"] })),
    { status: 400 },
  );
  // A replaced draft that is gone stays MAIL_NOT_FOUND and nothing is stored.
  assert.equal(
    await code(f.run((c) => saveDraft(c, sender, fields, { replaceUid: 99 }))),
    "MAIL_NOT_FOUND",
  );
  assert.equal(f.drafts().length, 1);
});

test("loadDraftParts refuses a changed draft", async (t) => {
  const f = await partsFixture(t);
  const saved = await f.run((c) => saveDraft(c, sender, fields, { files: [csv] }));
  const [a] = saved.attachments;
  assert.equal(
    await code(
      f.run((c) =>
        loadDraftParts(c, saved.draftUid, [{ part: a.part, partSha256: "0".repeat(64) }]),
      ),
    ),
    "MAIL_DRAFT_CHANGED",
  );
  assert.equal(
    await code(f.run((c) => loadDraftParts(c, saved.draftUid, [{ ...a, part: "9" }]))),
    "MAIL_DRAFT_CHANGED",
  );
  assert.equal(
    await code(f.run((c) => loadDraftParts(c, saved.draftUid + 1, [a]))),
    "MAIL_DRAFT_CHANGED",
  );
  // Unchanged, the same parts load.
  const raws = await f.run((c) => loadDraftParts(c, saved.draftUid, [a]));
  assert.equal(raws.length, 1);
  assert.equal(sha256(raws[0]), a.partSha256);
});

test("more than 25 MB of attachments is refused before anything is stored", async (t) => {
  const f = await partsFixture(t);
  const half = (name) => ({
    filename: name,
    content: Buffer.alloc(13_107_200, 1),
    contentType: "application/octet-stream",
  });
  const over = { ...half("c.bin"), content: Buffer.alloc(1, 1) };
  assert.equal(
    await code(
      f.run((c) =>
        saveDraft(c, sender, fields, { files: [half("a.bin"), half("b.bin"), over] }),
      ),
    ),
    "MAIL_ATTACHMENT_TOO_LARGE",
  );
  assert.equal(
    await code(
      f.run((c) =>
        saveDraft(c, sender, fields, {
          files: [{ ...half("big.bin"), content: Buffer.alloc(26_214_401) }],
        }),
      ),
    ),
    "MAIL_ATTACHMENT_TOO_LARGE",
  );
  assert.equal(f.drafts().length, 0);
});

test("an owner-made draft with HTML and an attachment loads its attachment", async (t) => {
  const f = await partsFixture(t);
  const content = pdfWith("Invoice");
  const { uid } = f.imap.mailbox.append("Drafts", {
    raw: Buffer.from(
      mimeWith({
        subject: "Styled",
        text: "Grüße",
        html: "<p>Grüße</p>",
        attachments: [{ name: "a.pdf", type: "application/pdf", content }],
      }),
      "latin1",
    ),
    flags: ["\\Draft"],
  });
  const loaded = await f.run((c) => loadDraft(c, uid));
  assert.equal(loaded.fields.body, "Grüße");
  assert.deepEqual(
    loaded.attachments.map(({ part, name, type, size, sha256: digest }) => ({
      part,
      name,
      type,
      size,
      digest,
    })),
    [
      {
        part: "2",
        name: "a.pdf",
        type: "application/pdf",
        size: content.length,
        digest: sha256(content),
      },
    ],
  );
});

test("attachmentBytes returns decoded bytes, the UID validity and size refusals", async (t) => {
  const f = await partsFixture(t);
  const content = pdfWith("49.99");
  const { uid } = f.imap.mailbox.append("INBOX", {
    raw: Buffer.from(
      mimeWith({
        text: "Hi",
        attachments: [
          { name: "a.pdf", type: "application/pdf", content },
          {
            name: "n.txt",
            type: "text/plain",
            content: "Grüße",
            encoding: "quoted-printable",
          },
        ],
      }),
      "latin1",
    ),
  });
  const got = await f.run((c) =>
    attachmentBytes(c, "INBOX", uid, "2", { maxBytes: 1_000_000 }),
  );
  assert.equal(got.name, "a.pdf");
  assert.equal(got.type, "application/pdf");
  assert.deepEqual(got.bytes, content);
  assert.equal(got.uidValidity, String(f.imap.folder("INBOX").uidValidity));
  const text = await f.run((c) =>
    attachmentBytes(c, "INBOX", uid, "3", { maxBytes: 1_000_000 }),
  );
  assert.equal(text.bytes.toString("utf8"), "Grüße");
  assert.equal(
    await code(
      f.run((c) =>
        attachmentBytes(c, "INBOX", uid, "2", { maxBytes: content.length - 1 }),
      ),
    ),
    "MAIL_ATTACHMENT_TOO_LARGE",
  );
  // The text body is no attachment, and a part that is not there is not found.
  for (const part of ["1", "4"])
    assert.equal(
      await code(f.run((c) => attachmentBytes(c, "INBOX", uid, part, { maxBytes: 1e6 }))),
      "MAIL_NOT_FOUND",
    );
  // Reading never sets \Seen.
  assert.equal(f.imap.folder("INBOX").messages[0].flags.has("\\Seen"), false);
});

test("fetchRawParts and messageParts return raw parts and refuse unknown messages", async (t) => {
  const f = await partsFixture(t);
  const { uid } = f.imap.mailbox.append("INBOX", {
    raw: Buffer.from(
      mimeWith({
        text: "Hi",
        attachments: [{ name: "b.csv", type: "text/csv", content: "a;b" }],
      }),
      "latin1",
    ),
  });
  const result = await f.run(async (c) => {
    await openFolder(c, "INBOX");
    const raws = await fetchRawParts(c, uid, ["2"]);
    const parts = await messageParts(c, uid, { raw: true });
    return { raws, parts, missing: await code(messageParts(c, uid + 5)) };
  });
  const raw = result.raws.get("2");
  assert.match(raw.toString(), /^Content-Type: text\/csv; name="b.csv"\r\n/);
  assert.ok(raw.toString().endsWith(Buffer.from("a;b").toString("base64")));
  assert.equal(result.parts.length, 1);
  assert.deepEqual(result.parts[0].raw, raw);
  assert.equal(result.parts[0].sha256, sha256(Buffer.from("a;b")));
  assert.equal(result.missing, "MAIL_NOT_FOUND");
});

test("a text file attached to a draft is never taken for its body", async (t) => {
  const f = await partsFixture(t);
  const raw = mimeWith({
    text: "Body",
    attachments: [{ name: "notes.txt", type: "text/plain", content: "Not the body" }],
  }).replace(
    /--mix\r\nContent-Type: text\/plain; charset=UTF-8\r\n[^]*?\r\n(?=--mix)/,
    "",
  );
  const { uid } = f.imap.mailbox.append("Drafts", {
    raw: Buffer.from(raw, "latin1"),
    flags: ["\\Draft"],
  });
  assert.doesNotMatch(raw, /Body/);
  assert.equal(await code(f.run((c) => loadDraft(c, uid))), "MAIL_DRAFT_UNSUPPORTED");
});
