import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mailFilesFixture } from "../helpers/mail-files-fixture.js";
import { docxWith, encryptedPdf, mimeWith, pdfWith } from "../helpers/mail-documents.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { attachmentLimits, sha256 } from "../../server/features/mail/mail-parts.js";

const pdfType = "application/pdf";
const docxType =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const pdfBytes = pdfWith("Total: EUR 49.99");

async function code(promise) {
  try {
    await promise;
  } catch (error) {
    return toolError(error).code;
  }
  assert.fail("the call succeeded");
}

async function setup(t, options = {}) {
  const f = await mailFilesFixture(t);
  f.access({ level: "read", ...options });
  const seed = (attachments) =>
    f.imap.mailbox.append("INBOX", {
      raw: Buffer.from(mimeWith({ text: "See attached.", attachments }), "latin1"),
      internalDate: "2026-10-27T08:00:00Z",
    }).uid;
  // Message 1: the invoice PDF as part 2.
  seed([{ name: "Rechnung.pdf", type: pdfType, content: pdfBytes }]);
  const mail = (input, inv) =>
    f.mail({ accountId: f.account.id, action: "attachment", ...input }, inv);
  // The FETCHes of attachment bodies (part 2), counted through the fake's hook.
  const fetched = [];
  f.imap.mailbox.failFetch = (items) => {
    if (/BODY\.PEEK\[2\]/i.test(items)) fetched.push(items);
    return false;
  };
  const cache = f.mailStore.textCache;
  const cacheKey = (uid, part = "2") =>
    cache.key({
      accountId: f.account.id,
      folder: "INBOX",
      uidValidity: "1000",
      uid,
      part,
    });
  return { ...f, seed, mail, fetched, cache, cacheKey };
}

test("save puts the attachment into mail/<account> at Read level", async (t) => {
  const f = await setup(t);
  const r = await f.mail({ uid: 1, part: "2", mode: "save" });
  assert.deepEqual(r.saved, { workspace: true, path: "mail/Private/Rechnung.pdf" });
  assert.deepEqual(fs.readFileSync(f.ws(r.saved.path)), pdfBytes);
  assert.equal(r.untrusted, true);
  assert.equal(r.accountId, f.account.id);
  assert.equal(r.account, "Private");
  assert.equal(r.folder, "INBOX");
  assert.equal(r.uid, 1);
  assert.equal(r.part, "2");
  assert.equal(r.name, "Rechnung.pdf");
  assert.equal(r.type, pdfType);
  assert.equal(r.size, pdfBytes.length);
  assert.equal(r.sha256, sha256(pdfBytes));
  assert.match(r.notice, /untrusted/);
  // The mail stays unread: the download never sets \Seen.
  assert.equal(f.imap.folder("INBOX").messages[0].flags.has("\\Seen"), false);
});

test("a second save gets a numeric suffix", async (t) => {
  const f = await setup(t);
  await f.mail({ uid: 1, part: "2", mode: "save" });
  const second = await f.mail({ uid: 1, part: "2", mode: "save" });
  assert.deepEqual(second.saved, {
    workspace: true,
    path: "mail/Private/Rechnung (2).pdf",
  });
  assert.deepEqual(fs.readFileSync(f.ws("mail/Private/Rechnung (2).pdf")), pdfBytes);
  assert.deepEqual(fs.readdirSync(f.ws("mail/Private")).sort(), [
    "Rechnung (2).pdf",
    "Rechnung.pdf",
  ]);
});

test("save to a writable project folder returns project id and relative path", async (t) => {
  const f = await setup(t);
  const id = f.folderProject.id;
  f.access({ level: "read", projectFiles: { [id]: "write" } });
  const r = await f.mail({
    uid: 1,
    part: "2",
    mode: "save",
    projectId: id,
    path: "invoices",
  });
  assert.deepEqual(r.saved, {
    projectId: id,
    projectName: f.folderProject.name,
    path: "invoices/Rechnung.pdf",
  });
  assert.deepEqual(fs.readFileSync(f.proj("invoices/Rechnung.pdf")), pdfBytes);
  // Nothing went to the workspace.
  assert.equal(fs.existsSync(f.ws("mail")), false);
});

test("a read-only project grant or a workspace path outside mail/ is refused", async (t) => {
  const f = await setup(t);
  const id = f.folderProject.id;
  f.access({ level: "read", projectFiles: { [id]: "read" } });
  const project = { uid: 1, part: "2", mode: "save", projectId: id, path: "invoices" };
  assert.equal(await code(f.mail(project)), "PROJECT_READ_ONLY");
  assert.equal(fs.existsSync(f.proj("invoices")), false);
  assert.equal(
    await code(f.mail({ uid: 1, part: "2", mode: "save", path: "skills" })),
    "MAIL_SAVE_REFUSED",
  );
  assert.equal(fs.existsSync(f.ws("skills")), false);
  assert.deepEqual(f.fetched, []);
  assert.equal(f.audit.filter((e) => e.action === "mail.downloaded").length, 0);
});

test("an attachment over the limit is refused, nothing written", async (t) => {
  const f = await setup(t);
  f.workflows.mail.limits.attachments = { ...attachmentLimits, fileBytes: 10 };
  assert.equal(
    await code(f.mail({ uid: 1, part: "2", mode: "save" })),
    "MAIL_ATTACHMENT_TOO_LARGE",
  );
  assert.equal(fs.existsSync(f.ws("mail")), false);
  assert.equal(
    await code(f.mail({ uid: 1, part: "2", mode: "text" })),
    "MAIL_ATTACHMENT_TOO_LARGE",
  );
  assert.equal(f.audit.filter((e) => e.action === "mail.downloaded").length, 0);
});

test("text returns bounded, untrusted text", async (t) => {
  const f = await setup(t);
  const long = "x".repeat(40_000);
  const uid = f.seed([
    { name: "Bericht.docx", type: docxType, content: await docxWith(long) },
  ]);
  const r = await f.mail({ uid, part: "2", mode: "text" });
  assert.equal(r.text.length, 32_000);
  assert.equal(r.text, long.slice(0, 32_000));
  assert.equal(r.truncated, true);
  assert.equal(r.untrusted, true);
  assert.match(r.notice, /untrusted/);
  assert.equal(r.name, "Bericht.docx");
  assert.equal(r.type, docxType);
  assert.equal(r.uid, uid);
  // Text is never written to the workspace and never audited.
  assert.equal(fs.existsSync(f.ws("mail")), false);
  assert.equal(f.audit.filter((e) => e.action === "mail.downloaded").length, 0);

  const pdf = await f.mail({ uid: 1, part: "2", mode: "text" });
  assert.match(pdf.text, /Total: EUR 49\.99/);
  assert.equal(pdf.truncated, false);
});

test("text is cached and read from the cache the search shares", async (t) => {
  const f = await setup(t);
  const first = await f.mail({ uid: 1, part: "2", mode: "text" });
  assert.equal(f.fetched.length, 1);
  assert.match(f.cache.get(f.account.id, f.cacheKey(1)).text, /49\.99/);
  const again = await f.mail({ uid: 1, part: "2", mode: "text" });
  assert.equal(again.text, first.text);
  assert.equal(f.fetched.length, 1);
  // The attachment-text search finds it without downloading again.
  const search = await f.call(f.ownTurn(), {
    action: "search",
    accountId: f.account.id,
    query: { attachmentText: "49.99" },
  });
  assert.deepEqual(
    search.messages.map((m) => m.uid),
    [1],
  );
  assert.equal(f.fetched.length, 1);
});

test("a document failure is cached as its code; an unrelated mailbox change drops the write", async (t) => {
  const f = await setup(t);
  const uid = f.seed([{ name: "secret.pdf", type: pdfType, content: encryptedPdf() }]);
  assert.equal(await code(f.mail({ uid, part: "2", mode: "text" })), "MAIL_TEXT_FAILED");
  assert.deepEqual(f.cache.get(f.account.id, f.cacheKey(uid)), {
    failed: "MAIL_TEXT_FAILED",
  });
  assert.equal(await code(f.mail({ uid, part: "2", mode: "text" })), "MAIL_TEXT_FAILED");
  assert.equal(f.fetched.length, 1);

  // The account reaches another mailbox while the text is read: nothing is stored.
  const store = f.mailStore;
  const withImap = store.withImap.bind(store);
  store.withImap = async (id, fn) => {
    const result = await withImap(id, fn);
    f.cache.clearAccount(id);
    return result;
  };
  const r = await f.mail({ uid: 1, part: "2", mode: "text" });
  assert.match(r.text, /49\.99/);
  assert.equal(f.cache.get(f.account.id, f.cacheKey(1)), null);
});

test("text of an image is MAIL_TEXT_UNSUPPORTED", async (t) => {
  const f = await setup(t);
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const uid = f.seed([{ name: "photo.png", type: "image/png", content: png }]);
  assert.equal(
    await code(f.mail({ uid, part: "2", mode: "text" })),
    "MAIL_TEXT_UNSUPPORTED",
  );
  // Refused before the image was downloaded, and nothing cached.
  assert.deepEqual(f.fetched, []);
  assert.equal(f.cache.get(f.account.id, f.cacheKey(uid)), null);
  // Saving it works: it is a file like any other.
  const saved = await f.mail({ uid, part: "2", mode: "save" });
  assert.deepEqual(fs.readFileSync(f.ws(saved.saved.path)), png);
});

test("an unknown part is MAIL_NOT_FOUND", async (t) => {
  const f = await setup(t);
  assert.equal(await code(f.mail({ uid: 1, part: "9", mode: "save" })), "MAIL_NOT_FOUND");
  assert.equal(await code(f.mail({ uid: 1, part: "9", mode: "text" })), "MAIL_NOT_FOUND");
  assert.equal(
    await code(f.mail({ uid: 99, part: "2", mode: "save" })),
    "MAIL_NOT_FOUND",
  );
  assert.equal(fs.existsSync(f.ws("mail")), false);
});

test("fields of another action or mode are invalid", async (t) => {
  const f = await setup(t);
  for (const input of [
    { uid: 1, part: "2" },
    { uid: 1, mode: "save" },
    { part: "2", mode: "save" },
    { uid: 1, part: "2", mode: "text", path: "mail/x" },
    { uid: 1, part: "2", mode: "text", projectId: f.folderProject.id, path: "x" },
    { uid: 1, part: "2", mode: "save", projectId: f.folderProject.id },
    { uid: 1, part: "2", mode: "save", flag: "read" },
    { uid: 1, part: "2", mode: "save", folder: "IN\nBOX" },
  ])
    assert.equal(await code(f.mail(input)), "INVALID_INPUT", JSON.stringify(input));
  assert.equal(fs.existsSync(f.ws("mail")), false);
});

test("the audit names no file, path or content", async (t) => {
  const f = await setup(t);
  await f.mail({ uid: 1, part: "2", mode: "save" });
  await f.mail({ uid: 1, part: "2", mode: "text" });
  const records = f.audit.filter((e) => e.action === "mail.downloaded");
  assert.equal(records.length, 1);
  assert.equal(records[0].resourceType, "mail");
  assert.equal(records[0].resourceId, f.account.id);
  assert.deepEqual(records[0].details, {
    kind: "attachment",
    assistantId: f.id,
    bytes: pdfBytes.length,
    destination: "workspace",
  });
  // Ids and the size are known values; the rest names nothing of the mail.
  const log = JSON.stringify(records)
    .replaceAll(f.account.id, "<account>")
    .replaceAll(f.id, "<agent>")
    .replace(`"bytes":${pdfBytes.length}`, `"bytes":"<n>"`);
  assert.match(log, /"destination":"workspace"/);
  for (const s of ["Rechnung", "mail/Private", "49"])
    assert.equal(log.includes(s), false, s);
});

test("a refused origin cannot download", async (t) => {
  const f = await setup(t);
  const forwarded = f.ownTurn({ kind: "owner", forwarded: true });
  for (const mode of ["save", "text"])
    assert.equal(
      await code(f.mail({ uid: 1, part: "2", mode }, forwarded)),
      "MAIL_ORIGIN_REFUSED",
    );
  // A hook run without its live Email tick is refused too.
  f.hook.mail = false;
  assert.equal(
    await code(f.mail({ uid: 1, part: "2", mode: "text" }, f.hookTurn())),
    "MAIL_ORIGIN_REFUSED",
  );
  assert.deepEqual(f.fetched, []);
  assert.equal(fs.existsSync(f.ws("mail")), false);
  assert.equal(f.audit.filter((e) => e.action === "mail.downloaded").length, 0);
});
