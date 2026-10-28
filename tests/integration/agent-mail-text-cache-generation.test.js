import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mailFixture } from "../helpers/agent-mail-fixture.js";
import { mimeWith, pdfWith } from "../helpers/mail-documents.js";
import { extractLimits, extractText } from "../../server/features/mail/mail-extract.js";

const owner = { role: "owner" };
const hangUrl = new URL("../fixtures/mail-extract-hang.mjs", import.meta.url);

// Both extraction slots held until their own time limit ends them.
const holdSlots = (timeoutMs) =>
  Array.from({ length: extractLimits.concurrency }, () =>
    extractText(pdfWith("x"), "pdf", {
      scriptUrl: hangUrl,
      limits: { ...extractLimits, timeoutMs },
    }).catch((error) => error),
  );

async function until(check) {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "the condition was never met");
}

async function inFlight(t) {
  const f = await mailFixture(t);
  f.grant("read");
  f.imap.mailbox.append("INBOX", {
    raw: Buffer.from(
      mimeWith({
        subject: "Invoice",
        attachments: [
          { name: "a.pdf", type: "application/pdf", content: pdfWith("49.99") },
        ],
      }),
      "latin1",
    ),
  });
  let downloads = 0;
  f.imap.mailbox.failFetch = (items) => {
    if (/BODY\.PEEK\[2\]/i.test(items)) downloads++;
    return false;
  };
  const directory = path.join(f.dataDir, "mail/text-cache", f.account.id);
  const entries = () => (fs.existsSync(directory) ? fs.readdirSync(directory) : []);
  // The search downloads the attachment, then waits for a slot to extract it.
  const held = holdSlots(1_000);
  const search = f.call(f.ownTurn(), {
    accountId: f.account.id,
    action: "search",
    query: { attachmentText: "49.99" },
  });
  await until(() => downloads === 1);
  return { ...f, held, search, entries };
}

test("a search begun before another IMAP login writes nothing into the cache", async (t) => {
  const f = await inFlight(t);
  const generation = f.mailStore.textCache.generation(f.account.id);
  f.mailStore.update(
    f.account.id,
    { imap: { username: "other@example.com" }, password: "pw-other" },
    owner,
  );
  assert.equal(f.mailStore.textCache.generation(f.account.id), generation + 1);
  await Promise.all(f.held);
  // The old search still answers its caller from the mailbox it was connected to.
  const result = await f.search;
  assert.deepEqual(
    result.messages.map((m) => m.uid),
    [1],
  );
  // Its text went nowhere: nothing to serve to a search of the new mailbox.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(f.entries(), []);
  const key = f.mailStore.textCache.key({
    accountId: f.account.id,
    folder: "INBOX",
    uidValidity: String(f.imap.folder("INBOX").uidValidity),
    uid: 1,
    part: "2",
  });
  assert.equal(f.mailStore.textCache.get(f.account.id, key), null);
  // A write with the current generation still works.
  assert.equal(
    f.mailStore.textCache.set(f.account.id, key, { text: "new", truncated: false }),
    true,
  );
});

test("a search begun before the account was removed writes nothing", async (t) => {
  const f = await inFlight(t);
  f.mailStore.remove(f.account.id, owner);
  await Promise.all(f.held);
  await f.search.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(f.entries(), []);
});

test("an unchanged account keeps what the search extracted", async (t) => {
  const f = await inFlight(t);
  // A rename is no other mailbox: the generation stays.
  f.mailStore.update(f.account.id, { name: "Renamed" }, owner);
  await Promise.all(f.held);
  await f.search;
  await until(() => f.entries().length === 1);
});

test("the store keys cached text by the mailbox its account reaches", async (t) => {
  const f = await mailFixture(t);
  const cache = f.mailStore.textCache;
  const fields = {
    accountId: f.account.id,
    folder: "INBOX",
    uidValidity: "1",
    uid: 1,
    part: "2",
  };
  const before = cache.key(fields);
  assert.equal(cache.set(f.account.id, before, { text: "old", truncated: false }), true);
  f.mailStore.update(f.account.id, { name: "Renamed" }, owner);
  assert.equal(cache.key(fields), before);
  f.mailStore.update(
    f.account.id,
    { imap: { username: "other@example.com" }, password: "pw-other" },
    owner,
  );
  assert.notEqual(cache.key(fields), before);
  assert.equal(cache.get(f.account.id, cache.key(fields)), null);
});

test("the text-cache key reads the catalog once, and again after it is written", async (t) => {
  const f = await mailFixture(t);
  const s = f.mailStore;
  const id = f.account.id;
  const keyOf = () =>
    s.textCache.key({
      accountId: id,
      folder: "INBOX",
      uidValidity: "1",
      uid: 1,
      part: "2",
    });
  const reads = t.mock.method(s, "rows");
  const first = keyOf();
  for (let i = 0; i < 5; i++) assert.equal(keyOf(), first);
  assert.equal(reads.mock.callCount(), 1);
  // A written catalog is read again: the same mailbox keeps its key, another one not.
  s.update(id, { name: "Renamed" }, owner);
  assert.equal(keyOf(), first);
  s.update(id, { imap: { username: "other" }, password: "pw-again" }, owner);
  assert.notEqual(keyOf(), first);
});
