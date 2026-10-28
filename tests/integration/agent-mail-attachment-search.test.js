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
import {
  extractionQueues,
  extractLimits,
  extractText,
} from "../../server/features/mail/mail-extract.js";

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
  // Summaries carry no body section: not one byte of an attachment came again.
  assert.equal(f.imap.mailbox.served, served);
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

// scanAttachmentText on its own IMAP connection, for options the tool cannot set.
const scanWith = (f, options) =>
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

// Extractions that hold their slot until their own time limit ends them.
const hangUrl = new URL("../fixtures/mail-extract-hang.mjs", import.meta.url);
const holdSlots = (count, timeoutMs) =>
  Array.from({ length: count }, () =>
    extractText(pdfWith("x"), "pdf", {
      scriptUrl: hangUrl,
      limits: { ...extractLimits, timeoutMs },
    }).catch((error) => error),
  );

test("a full extraction queue skips candidates without caching them", async (t) => {
  const f = await searchFixture(t);
  f.seed([f.file("a.pdf", pdfWith("49.99"))], "a");
  f.seed([f.file("b.pdf", pdfWith("49.99"))], "b");
  // Two running and sixteen waiting: the next extraction is refused as busy.
  const held = holdSlots(extractLimits.concurrency + extractLimits.queue, 1_500);
  const skipped = await scanWith(f, {});
  assert.deepEqual(
    [skipped.messages, skipped.scanned, skipped.partial, skipped.skipped],
    [[], 2, true, 2],
  );
  assert.equal(skipped.reason, undefined);
  assert.equal(f.cache.get(f.account.id, f.cacheKey(1)), null);
  await Promise.all(held);
  // With the queue free again the same search finds both.
  const found = await scanWith(f, {});
  assert.deepEqual(
    found.messages.map((m) => m.uid),
    [2, 1],
  );
});

test("waiting for an extraction slot counts against the time limit", async (t) => {
  const f = await searchFixture(t);
  f.seed([f.file("a.pdf", pdfWith("49.99"))], "a");
  const held = holdSlots(extractLimits.concurrency, 1_500);
  const started = Date.now();
  const waiting = await scanWith(f, {
    uids: [1],
    budget: { candidates: 500, ms: 300, bytes: 209_715_200 },
  });
  assert.deepEqual([waiting.partial, waiting.reason, waiting.scanned], [true, "time", 0]);
  assert.ok(Date.now() - started < 1_400, "the search did not wait for the slot");
  // The extraction that waited left the queue with its bytes: nothing is held for a
  // search that gave up.
  assert.equal(extractionQueues().document.waiting, 0);
  await Promise.all(held);
  assert.equal(f.cache.get(f.account.id, f.cacheKey(1)), null);
  // The next search extracts it.
  const found = await scanWith(f, { uids: [1] });
  assert.deepEqual(
    found.messages.map((m) => m.uid),
    [1],
  );
  assert.match(f.cache.get(f.account.id, f.cacheKey(1)).text, /49\.99/);
});

test("a download that outlasts the deadline stops the search", async (t) => {
  const f = await searchFixture(t);
  f.seed([f.file("a.pdf", pdfWith("49.99"))], "a");
  // The deadline is not reached before the download starts, but passes during it.
  const result = await scanWith(f, {
    uids: [1],
    now: () => 0,
    deadline: 1,
    wait: () => Promise.resolve(),
  });
  assert.deepEqual([result.partial, result.reason, result.scanned], [true, "time", 0]);
  assert.equal(f.cache.get(f.account.id, f.cacheKey(1)), null);
});

test("an attachment too large for this call's limit is not cached", async (t) => {
  const f = await searchFixture(t);
  const pdf = pdfWith("Total: EUR 49.99");
  f.seed([f.file("a.pdf", pdf)], "a");
  // Its base64 size estimate fits the limit, its decoded bytes do not.
  const tight = await scanWith(f, { uids: [1], maxFileBytes: pdf.length - 1 });
  assert.equal(f.fetched.length, 1);
  assert.deepEqual(tight.messages, []);
  assert.equal(f.cache.get(f.account.id, f.cacheKey(1)), null);
  const roomy = await scanWith(f, { uids: [1] });
  assert.deepEqual(
    roomy.messages.map((m) => m.uid),
    [1],
  );
  assert.equal(f.fetched.length, 2);
});

test("only failures of the document are cached; bugs fail the search", async (t) => {
  const f = await searchFixture(t);
  f.seed([f.file("a.pdf", pdfWith("49.99"))], "a");
  f.seed([f.file("b.pdf", pdfWith("49.99"))], "b");
  // A time limit under load or a failed start: skipped, tried again next time.
  const load = await scanWith(f, {
    extract: async () => {
      throw mailError("MAIL_TEXT_FAILED");
    },
  });
  assert.deepEqual([load.partial, load.skipped, load.scanned], [true, 2, 2]);
  assert.equal(f.cache.get(f.account.id, f.cacheKey(2)), null);
  await assert.rejects(
    scanWith(f, {
      extract: async () => {
        throw new TypeError("bug");
      },
    }),
    TypeError,
  );
  assert.equal(f.cache.get(f.account.id, f.cacheKey(2)), null);
  const broken = await scanWith(f, {
    extract: async () => {
      throw Object.assign(mailError("MAIL_TEXT_FAILED"), { document: true });
    },
  });
  assert.deepEqual([broken.partial, broken.scanned], [false, 2]);
  assert.deepEqual(f.cache.get(f.account.id, f.cacheKey(2)), {
    failed: "MAIL_TEXT_FAILED",
  });
  // A server failure still fails the search.
  f.imap.mailbox.failFetch = (items) => /BODY\.PEEK\[2\]/i.test(items);
  await assert.rejects(scanWith(f, { uids: [1], cache: null }), {
    code: "MAIL_PROTOCOL",
  });
});

test("with a name filter, scanned counts up to the last candidate read", async (t) => {
  const f = await searchFixture(t);
  f.seed([f.file("a.pdf", pdfWith("Total 12.00"))], "1");
  f.seed([f.file("b.pdf", pdfWith("Total 49.99"))], "2");
  f.seed([f.file("c.png", Buffer.from("49.99"))], "3");
  f.seed([f.file("d.pdf", pdfWith("Total 49.99"))], "4");
  f.seed([f.file("e.png", Buffer.from("49.99"))], "5");
  const query = { attachmentText: "49.99", attachment: ".pdf" };
  // Stopped by the limit at uid 4, the second message from the newest.
  const one = await f.mail({ action: "search", query, limit: 1 });
  assert.deepEqual(
    [one.messages.map((m) => m.uid), one.scanned, one.partial],
    [[4], 2, false],
  );
  // Stopped by the candidate budget after uid 4 and uid 2 (the fourth message).
  f.workflows.mail.limits.search.candidates = 2;
  const capped = await f.mail({ action: "search", query });
  assert.deepEqual(
    [capped.messages.map((m) => m.uid), capped.scanned, capped.reason],
    [[4, 2], 4, "candidates"],
  );
  f.workflows.mail.limits.search.candidates = 500;
  const all = await f.mail({ action: "search", query });
  assert.deepEqual([all.scanned, all.partial], [5, false]);
  // A needle of only whitespace would match everything: refused.
  for (const attachmentText of ["   ", "\t\n"])
    await assert.rejects(f.mail({ action: "search", query: { attachmentText } }), {
      key: "invalid",
    });
});
