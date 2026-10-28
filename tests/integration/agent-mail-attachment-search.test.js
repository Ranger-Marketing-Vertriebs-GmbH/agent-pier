import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mailFixture } from "../helpers/agent-mail-fixture.js";
import {
  docxWith,
  encryptedZipDocx,
  mimeWith,
  pdfWith,
  xlsxWith,
  zipBombDocx,
} from "../helpers/mail-documents.js";
import { mailFileTypes } from "../../server/features/mail/mail-file-types.js";
import { mailError } from "../../server/features/mail/mail-connection.js";
import { scanAttachmentText } from "../../server/features/mail/mail-attachment-search.js";

const inbox = { folder: "INBOX", uidValidity: "1000" };

async function searchFixture(t) {
  const f = await mailFixture(t);
  f.grant("read");
  const seed = (attachments, subject = "Mail") =>
    f.imap.mailbox.append("INBOX", {
      raw: Buffer.from(
        mimeWith({ subject, text: "See attached.", attachments }),
        "latin1",
      ),
      internalDate: "2026-10-27T08:00:00Z",
    }).uid;
  const file = (name, content) => ({
    name,
    type: mailFileTypes[path.extname(name)] ?? "application/octet-stream",
    content,
  });
  const mail = (input) => f.call(f.ownTurn(), { accountId: f.account.id, ...input });
  // The FETCHes of attachment bodies (part 2), counted through the fake's hook.
  const fetched = [];
  f.imap.mailbox.failFetch = (items) => {
    if (/BODY\.PEEK\[2\]/i.test(items)) fetched.push(items);
    return false;
  };
  const cache = f.mailStore.textCache;
  const cacheKey = (uid, part = "2") =>
    cache.key({ accountId: f.account.id, ...inbox, uid, part });
  return { ...f, seed, file, mail, fetched, cache, cacheKey };
}

// Three invoices with the amount in a PDF, a DOCX and an XLSX, and one decoy.
async function invoices(f) {
  f.seed([f.file("invoice.pdf", pdfWith("Total: EUR 49.99"))], "pdf");
  f.seed([f.file("invoice.docx", await docxWith("Amount   due\n49.99 EUR"))], "docx");
  f.seed([f.file("invoice.xlsx", await xlsxWith([["Total", "49.99"]]))], "xlsx");
  f.seed([f.file("other.pdf", pdfWith("Total: EUR 12.00"))], "decoy");
}

test("attachmentText finds an amount inside a PDF, DOCX and XLSX", async (t) => {
  const f = await searchFixture(t);
  await invoices(f);
  const result = await f.mail({ action: "search", query: { attachmentText: "49.99" } });
  assert.deepEqual(result.messages.map((m) => m.uid).sort(), [1, 2, 3]);
  // Newest first, each with the summary and the attachments that matched.
  assert.deepEqual(
    result.messages.map((m) => m.uid),
    [3, 2, 1],
  );
  assert.equal(result.messages[0].attachmentMatches[0].part, "2");
  assert.deepEqual(result.messages[0].attachmentMatches, [
    { part: "2", name: "invoice.xlsx" },
  ]);
  assert.equal(result.messages[2].subject, "pdf");
  assert.equal(result.messages[2].hasAttachments, true);
  assert.equal(result.scanned, 4);
  assert.equal(result.partial, false);
  assert.equal(result.reason, undefined);
  assert.equal(result.untrusted, true);
  // Case, Unicode form and whitespace runs are folded on both sides.
  const folded = await f.mail({
    action: "search",
    query: { attachmentText: "AMOUNT DUE 49.99" },
  });
  assert.deepEqual(
    folded.messages.map((m) => m.uid),
    [2],
  );
  // limit stops at the newest matches without being partial.
  const one = await f.mail({
    action: "search",
    query: { attachmentText: "49.99" },
    limit: 1,
  });
  assert.deepEqual(
    one.messages.map((m) => m.uid),
    [3],
  );
  assert.equal(one.partial, false);
  // The other criteria narrow the candidates first, the name filter included.
  const named = await f.mail({
    action: "search",
    query: { attachmentText: "49.99", attachment: ".docx" },
  });
  assert.deepEqual(
    named.messages.map((m) => m.uid),
    [2],
  );
  const subject = await f.mail({
    action: "search",
    query: { attachmentText: "49.99", subject: "pdf" },
  });
  assert.deepEqual(
    subject.messages.map((m) => m.uid),
    [1],
  );
  assert.equal(subject.scanned, 1);
});

test("a second search is served from the cache", async (t) => {
  const f = await searchFixture(t);
  await invoices(f);
  const first = await f.mail({ action: "search", query: { attachmentText: "49.99" } });
  assert.equal(f.fetched.length, 4);
  const served = f.imap.mailbox.served;
  const second = await f.mail({ action: "search", query: { attachmentText: "49.99" } });
  assert.equal(f.fetched.length, 4);
  assert.deepEqual(second.messages, first.messages);
  // Only summaries were fetched again, never an attachment body.
  const decoy = await f.mail({ action: "search", query: { attachmentText: "12.00" } });
  assert.deepEqual(
    decoy.messages.map((m) => m.uid),
    [4],
  );
  assert.equal(f.fetched.length, 4);
  assert.ok(f.imap.mailbox.served - served < 10_000);
  // The entries are this account's 0600 files under the data folder.
  const directory = path.join(f.dataDir, "mail/text-cache", f.account.id);
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 4);
  for (const name of files)
    assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o600);
  assert.equal(f.cache.get(f.account.id, f.cacheKey(1)).text.includes("49.99"), true);
});

test("the candidate, time and byte budgets end with partial and a reason", async (t) => {
  const f = await searchFixture(t);
  await invoices(f);
  const search = () => f.mail({ action: "search", query: { attachmentText: "49.99" } });
  const limits = f.workflows.mail.limits.search;
  assert.deepEqual(limits, { candidates: 500, ms: 60_000, bytes: 209_715_200 });
  limits.bytes = 10;
  const bytes = await search();
  assert.deepEqual(
    [bytes.partial, bytes.reason, bytes.scanned, bytes.messages],
    [true, "bytes", 0, []],
  );
  assert.equal(f.fetched.length, 0);
  limits.bytes = 209_715_200;
  limits.ms = 0;
  const time = await search();
  assert.deepEqual(
    [time.partial, time.reason, time.scanned, time.messages],
    [true, "time", 0, []],
  );
  limits.ms = 60_000;
  // The newest two are the decoy and the XLSX.
  limits.candidates = 2;
  const candidates = await search();
  assert.deepEqual(
    [candidates.partial, candidates.reason, candidates.scanned],
    [true, "candidates", 2],
  );
  assert.deepEqual(
    candidates.messages.map((m) => m.uid),
    [3],
  );
  // Searching again with the full budget continues from the cache.
  limits.candidates = 500;
  const all = await search();
  assert.deepEqual(
    all.messages.map((m) => m.uid),
    [3, 2, 1],
  );
  assert.equal(all.partial, false);
  assert.equal(f.fetched.length, 4);
});

test("broken documents are skipped and cached as failed", async (t) => {
  const f = await searchFixture(t);
  f.seed([f.file("cut.pdf", pdfWith("49.99").subarray(0, 120))], "truncated");
  f.seed([f.file("locked.docx", await encryptedZipDocx())], "encrypted");
  f.seed([f.file("bomb.docx", await zipBombDocx())], "bomb");
  f.seed([f.file("ok.pdf", pdfWith("49.99"))], "good");
  const result = await f.mail({ action: "search", query: { attachmentText: "49.99" } });
  assert.deepEqual(
    result.messages.map((m) => m.uid),
    [4],
  );
  assert.equal(result.scanned, 4);
  assert.equal(result.partial, false);
  for (const uid of [1, 2, 3])
    assert.deepEqual(
      f.cache.get(f.account.id, f.cacheKey(uid)),
      { failed: "MAIL_TEXT_FAILED" },
      String(uid),
    );
  // A failure is not tried again.
  const before = f.fetched.length;
  await f.mail({ action: "search", query: { attachmentText: "49.99" } });
  assert.equal(f.fetched.length, before);
});

test("non-text and oversized attachments are never downloaded", async (t) => {
  const f = await searchFixture(t);
  f.seed([f.file("photo.png", Buffer.from("49.99"))], "image");
  f.seed([f.file("notes.txt", "Total 49.99")], "text");
  f.workflows.mail.limits.attachments = { fileBytes: 4 };
  const small = await f.mail({ action: "search", query: { attachmentText: "49.99" } });
  assert.deepEqual(small.messages, []);
  assert.equal(small.scanned, 2);
  assert.equal(f.fetched.length, 0);
  f.workflows.mail.limits.attachments = { fileBytes: 26_214_400 };
  const text = await f.mail({ action: "search", query: { attachmentText: "49.99" } });
  assert.deepEqual(
    text.messages.map((m) => m.uid),
    [2],
  );
  assert.equal(f.fetched.length, 1);
});

test("a busy extraction skips the candidate without caching it", async (t) => {
  const f = await searchFixture(t);
  f.seed([f.file("a.pdf", pdfWith("49.99"))], "a");
  f.seed([f.file("b.pdf", pdfWith("49.99"))], "b");
  const busy = async () => {
    throw Object.assign(mailError("MAIL_TEXT_FAILED"), { busy: true });
  };
  const scan = (options) =>
    f.mailStore.withImap(f.account.id, async (client) => {
      await client.mailboxOpen("INBOX", { readOnly: true });
      return scanAttachmentText(client, {
        accountId: f.account.id,
        ...inbox,
        uids: [2, 1],
        needle: "49.99",
        limit: 20,
        cache: f.cache,
        ...options,
      });
    });
  const skipped = await scan({ extract: busy });
  assert.deepEqual(
    [skipped.messages, skipped.scanned, skipped.partial, skipped.skipped],
    [[], 2, true, 2],
  );
  assert.equal(f.cache.get(f.account.id, f.cacheKey(1)), null);
  // Waiting for a slot counts against the time budget.
  let clock = 0;
  const waiting = await scan({
    extract: () => new Promise(() => {}),
    budget: { candidates: 500, ms: 50, bytes: 209_715_200 },
    now: () => clock,
    wait: (ms) => {
      clock += ms;
      return new Promise((resolve) => setTimeout(resolve, 5));
    },
  });
  assert.deepEqual([waiting.partial, waiting.reason, waiting.scanned], [true, "time", 0]);
  // A server failure still fails the search.
  f.imap.mailbox.failFetch = (items) => /BODY\.PEEK\[2\]/i.test(items);
  await assert.rejects(scan({}), { code: "MAIL_PROTOCOL" });
});
