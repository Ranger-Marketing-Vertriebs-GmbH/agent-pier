import test from "node:test";
import assert from "node:assert/strict";
import { searchMessages } from "../../server/features/mail/mail-search.js";
import { scanAttachmentText } from "../../server/features/mail/mail-attachment-search.js";

// The attachment-text search within its time and byte budgets, against imapflow
// stand-ins whose steps can hang: every IMAP step is given up on at the deadline,
// and every byte that came counts.

// The deadline timers never keep a process up; the server does, here this does.
const alive = setInterval(() => {}, 1_000);
test.after(() => clearInterval(alive));

const never = () => new Promise(() => {});
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const pdf = (uid, size) => ({
  uid,
  envelope: {},
  bodyStructure: {
    type: "multipart/mixed",
    childNodes: [
      { part: "1", type: "text/plain" },
      {
        part: "2",
        type: "application/pdf",
        encoding: "7bit",
        size,
        disposition: "attachment",
        dispositionParameters: { filename: `${uid}.pdf` },
      },
    ],
  },
});

function client(overrides = {}) {
  return {
    mailbox: { uidValidity: 1n },
    mailboxOpen: async () => ({}),
    search: async () => [1, 2, 3],
    fetchAll: async (range) => range.split(",").map((uid) => pdf(Number(uid), 10)),
    ...overrides,
  };
}

const search = (c, query = { attachmentText: "x" }) =>
  searchMessages(c, "INBOX", query, 10, {
    ms: 100,
    textScan: (scanClient, scan) =>
      scanAttachmentText(scanClient, { ...scan, extract: async () => ({ text: "" }) }),
  });

for (const [step, overrides] of [
  ["opening the folder", { mailboxOpen: never }],
  ["the UID SEARCH", { search: never }],
  ["a name-filter batch", { fetchAll: never }],
]) {
  test(`${step} is given up on at the deadline`, async () => {
    const started = Date.now();
    const result = await search(client(overrides), {
      attachmentText: "x",
      attachment: "pdf",
    });
    assert.ok(Date.now() - started < 1_000, "returned near the deadline");
    assert.equal(result.partial, true);
    assert.equal(result.reason, "time");
    assert.deepEqual(result.messages, []);
  });
}

test("a candidate batch of the text scan is given up on at the deadline", async () => {
  const started = Date.now();
  const result = await search(client({ fetchAll: never }));
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual([result.partial, result.reason, result.scanned], [true, "time", 0]);
});

test("a programming error in a download given up on is logged", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const c = client({
    fetchOne: async () => {
      await settle();
      throw new TypeError("boom");
    },
  });
  const result = await scanAttachmentText(c, {
    folder: "INBOX",
    uidValidity: "1",
    rows: [pdf(1, 10)],
    needle: "x",
    limit: 10,
    now: () => 0,
    deadline: 1,
    wait: () => Promise.resolve(),
  });
  assert.equal(result.reason, "time");
  await settle();
  await settle();
  assert.deepEqual(
    errors.mock.calls.map((call) => call.arguments),
    [["Mail attachment download failed:", "TypeError"]],
  );
});

test("a part refused as too large after its download counts its bytes", async () => {
  let downloads = 0;
  // BODYSTRUCTURE says 10 bytes; the server sends 1,000.
  const c = client({
    fetchOne: async (uid) => {
      downloads++;
      return {
        uid: Number(uid),
        bodyParts: new Map([
          ["2.mime", Buffer.from("Content-Type: application/pdf\r\n\r\n")],
          ["2", Buffer.alloc(1_000, 0x41)],
        ]),
      };
    },
  });
  const result = await scanAttachmentText(c, {
    folder: "INBOX",
    uidValidity: "1",
    rows: [pdf(3, 10), pdf(2, 10), pdf(1, 10)],
    needle: "x",
    limit: 10,
    maxFileBytes: 500,
    budget: { candidates: 500, ms: 60_000, bytes: 15 },
  });
  assert.equal(downloads, 1);
  assert.deepEqual([result.partial, result.reason, result.scanned], [true, "bytes", 1]);
});
