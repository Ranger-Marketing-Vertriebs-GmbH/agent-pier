import test from "node:test";
import assert from "node:assert/strict";
import {
  attachmentLimits,
  decodedAtLeast,
  decodedRaw,
  decodeTransfer,
  messageParts,
  partInfo,
} from "../../server/features/mail/mail-parts.js";
import { loadDraft } from "../../server/features/mail/mail-drafts.js";
import { saveDraft } from "../../server/features/mail/mail-changes.js";
import {
  newFileEntries,
  unreadDraft,
} from "../../server/features/assistants/mail/agent-mail-draft-files.js";

// An imapflow stand-in that records each FETCH query; `structure` is the message's
// BODYSTRUCTURE and `appendUid` the UID an APPEND reports.
function stubClient({ structure, appendUid } = {}) {
  const fetches = [];
  return {
    fetches,
    capabilities: new Set(["MOVE"]),
    mailbox: { uidValidity: 7n },
    list: async () => [
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "Drafts", specialUse: "\\Drafts" },
      { path: "Trash", specialUse: "\\Trash" },
    ],
    mailboxOpen: async () => ({}),
    getMailboxLock: async () => ({ release() {} }),
    append: async () => ({ uid: appendUid }),
    download: async () => ({ content: null }),
    fetchOne: async (uid, query) => {
      fetches.push(query);
      return {
        uid: Number(uid),
        envelope: { to: [{ address: "bob@example.org" }], subject: "Big" },
        headers: "",
        bodyStructure: structure,
        bodyParts: new Map(),
      };
    },
  };
}

const huge = (part, size, encoding = "base64") => ({
  part,
  type: "application/octet-stream",
  encoding,
  size,
  disposition: "attachment",
  dispositionParameters: { filename: `${part}.bin` },
});
const mixed = (...childNodes) => ({
  type: "multipart/mixed",
  childNodes: [{ part: "1", type: "text/plain", size: 2 }, ...childNodes],
});

test("decodeTransfer decodes base64, quoted-printable and 8bit", () => {
  assert.equal(decodeTransfer(Buffer.from("SGVs\r\nbG8="), "base64").toString(), "Hello");
  assert.equal(
    decodeTransfer(Buffer.from("Gr=C3=BC=\r\nße"), "quoted-printable").toString(),
    "Grüße",
  );
  assert.equal(decodeTransfer(Buffer.from("x"), "8bit").toString(), "x");
  assert.throws(() => decodeTransfer(Buffer.from("x"), "x-uuencode"), {
    code: "MAIL_PROTOCOL",
  });
});

test("decodeTransfer keeps binary bytes and malformed escapes, ignores case", () => {
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  assert.deepEqual(decodeTransfer(bytes, "binary"), bytes);
  assert.deepEqual(decodeTransfer(bytes, "7BIT"), bytes);
  assert.deepEqual(decodeTransfer(bytes, undefined), bytes);
  assert.equal(
    decodeTransfer(Buffer.from("a=ZZb=3D=\nc"), "Quoted-Printable").toString(),
    "a=ZZb=c",
  );
  assert.equal(decodeTransfer(Buffer.from(" SGk=\n"), " BASE64 ").toString(), "Hi");
});

test("decodedRaw decodes a raw part by its own transfer encoding", () => {
  const raw = Buffer.from(
    'Content-Type: application/pdf; name="a.pdf"\r\nContent-Transfer-Encoding:\r\n base64\r\n\r\nJVBE\r\nRi0=',
  );
  assert.equal(decodedRaw(raw).toString("latin1"), "%PDF-");
  assert.equal(
    decodedRaw(Buffer.from("Content-Type: text/csv\r\n\r\na,b")).toString(),
    "a,b",
  );
});

test("partInfo estimates the decoded size of a base64 part", () => {
  assert.deepEqual(
    partInfo({
      part: "2",
      type: "application/pdf",
      encoding: "base64",
      size: 400,
      dispositionParameters: { filename: "a.pdf" },
      parameters: { charset: "utf-8" },
    }),
    {
      part: "2",
      name: "a.pdf",
      type: "application/pdf",
      size: 300,
      encoding: "base64",
      charset: "utf-8",
    },
  );
  assert.deepEqual(partInfo({ size: 10 }), {
    root: true,
    part: "1",
    name: null,
    type: "application/octet-stream",
    size: 10,
    encoding: "7bit",
    charset: null,
  });
});

test("the limits are 25 MB per mail and per file, 20 files", () => {
  assert.deepEqual(attachmentLimits, {
    mailBytes: 26_214_400,
    fileBytes: 26_214_400,
    files: 20,
  });
  assert.ok(Object.isFrozen(attachmentLimits));
});

test("the early bound is a lower bound for base64, quoted-printable and 8bit", () => {
  assert.equal(decodedAtLeast({ encoding: "base64", size: 660 }), 640);
  assert.equal(decodedAtLeast({ encoding: "quoted-printable", size: 300 }), 100);
  assert.equal(decodedAtLeast({ encoding: "8bit", size: 300 }), 300);
});

test("attachments over 25 MB together are refused before any part is fetched", async () => {
  // Two base64 parts of 14 MiB decoded each: neither alone, but both are too much.
  const encoded = Math.ceil(((14 * 1_048_576 * 4) / 3) * (66 / 64));
  const structure = mixed(huge("2", encoded), huge("3", encoded));
  const client = stubClient({ structure });
  await assert.rejects(messageParts(client, 5), { code: "MAIL_ATTACHMENT_TOO_LARGE" });
  assert.equal(client.fetches.filter((q) => q.bodyParts).length, 0);
  // A draft like it is refused by loadDraft the same way.
  const draft = stubClient({ structure });
  await assert.rejects(loadDraft(draft, 5), { code: "MAIL_ATTACHMENT_TOO_LARGE" });
  assert.equal(draft.fetches.filter((q) => q.bodyParts).length, 0);
  // One quoted-printable part of 3 x 25 MB + 3 characters also counts.
  const qp = stubClient({
    structure: mixed(huge("2", attachmentLimits.mailBytes * 3 + 3, "quoted-printable")),
  });
  await assert.rejects(messageParts(qp, 5), { code: "MAIL_ATTACHMENT_TOO_LARGE" });
  assert.equal(qp.fetches.filter((q) => q.bodyParts).length, 0);
});

test("a stored draft without its UID is MAIL_PROTOCOL when it carries parts", async () => {
  const account = { address: "agent@example.com", displayName: "" };
  const fields = { to: ["bob@example.org"], cc: [], bcc: [], subject: "x", body: "y" };
  const file = {
    filename: "a.txt",
    content: Buffer.from("a"),
    contentType: "text/plain",
  };
  await assert.rejects(saveDraft(stubClient(), account, fields, { files: [file] }), {
    code: "MAIL_PROTOCOL",
  });
  await assert.rejects(saveDraft(stubClient(), account, fields, { html: "<p>y</p>" }), {
    code: "MAIL_PROTOCOL",
  });
  // A plain draft keeps working without UIDPLUS, as before.
  const plain = await saveDraft(stubClient(), account, fields);
  assert.equal(plain.draftUid, null);
  assert.deepEqual(plain.attachments, []);
  assert.equal(plain.htmlPart, null);
});

test("a draft that does not read back keeps the read's error as its cause", async (t) => {
  const account = { address: "agent@example.com", displayName: "" };
  const fields = { to: ["bob@example.org"], cc: [], bcc: [], subject: "x", body: "y" };
  const failure = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
  const client = stubClient({ appendUid: 5 });
  client.fetchOne = async () => {
    throw failure;
  };
  const errors = t.mock.method(console, "error", () => {});
  const saved = await saveDraft(client, account, fields);
  assert.equal(saved.unreadable, true);
  // Logged once, with its code and message only.
  assert.deepEqual(
    errors.mock.calls.map((call) => call.arguments),
    [["Mail draft read-back failed:", "ECONNRESET", "fetch failed"]],
  );
  assert.equal(saved.cause, failure);
  // Never spread into what an agent's result is built from.
  assert.equal({ ...saved }.cause, undefined);
  const error = unreadDraft(saved);
  assert.equal(error.code, "MAIL_PROTOCOL");
  assert.equal(error.cause, failure);
  assert.equal(Object.keys(error).includes("cause"), false);
  assert.throws(() => newFileEntries(saved, { read: [], files: {} }), {
    code: "MAIL_PROTOCOL",
    cause: failure,
  });
});

test("removed attachments do not count toward the size bound of a replaced draft", async () => {
  const account = { address: "agent@example.com", displayName: "" };
  const fields = { to: ["bob@example.org"], cc: [], bcc: [], subject: "x", body: "y" };
  const small = Buffer.from("Content-Type: text/csv\r\n\r\na,b");
  const client = stubClient({
    appendUid: 6,
    structure: mixed(huge("2", attachmentLimits.mailBytes * 2), {
      ...huge("3", small.length, "7bit"),
      dispositionParameters: { filename: "keep.csv" },
    }),
  });
  const fetchOne = client.fetchOne;
  client.fetchOne = async (uid, query, options) => {
    const row = await fetchOne(uid, query, options);
    row.bodyParts = new Map([
      ["3.mime", small.subarray(0, 24)],
      ["3", small.subarray(24)],
    ]);
    return row;
  };
  const saved = await saveDraft(client, account, fields, {
    replaceUid: 5,
    removeNames: ["2.bin"],
  });
  assert.equal(saved.draftUid, 6);
  // The huge part was neither counted nor fetched.
  assert.ok(client.fetches.every((q) => !q.bodyParts?.includes("2")));
  // Without removing it the draft stays over the bound.
  await assert.rejects(saveDraft(client, account, fields, { replaceUid: 5 }), {
    code: "MAIL_ATTACHMENT_TOO_LARGE",
  });
});
