import test from "node:test";
import assert from "node:assert/strict";
import {
  composeMessage,
  draftFields,
  recipientsOf,
  replyHeaders,
} from "../../server/features/mail/mail-compose.js";

const message = {
  from: { name: "Ägent", address: "agent@example.com" },
  to: ['"Bob, Jr." <bob@example.org>'],
  cc: ["carol@example.org"],
  bcc: ["hidden@example.net"],
  subject: "Grüße",
  body: "Hallo Bob,\nbis bald.",
  messageId: "<draft-1@example.com>",
};

const headerBlock = (raw) => raw.toString("utf8").split("\r\n\r\n")[0];

test("composeMessage keeps Bcc only with keepBcc and writes UTF-8 plain text", async () => {
  const kept = await composeMessage(message, { keepBcc: true });
  const dropped = await composeMessage(message, { keepBcc: false });
  assert.ok(Buffer.isBuffer(kept));
  assert.match(headerBlock(kept), /^Bcc: hidden@example\.net$/m);
  assert.doesNotMatch(headerBlock(dropped), /^Bcc:/im);
  assert.doesNotMatch(dropped.toString(), /hidden@example\.net/);
  const head = headerBlock(kept);
  assert.match(head, /^Content-Type: text\/plain; charset=utf-8$/m);
  assert.match(head, /^Message-ID: <draft-1@example\.com>$/m);
  assert.match(head, /^Subject: =\?UTF-8\?Q\?Gr=C3=BC=C3=9Fe\?=$/m);
  assert.match(head, /^To: "Bob, Jr\." <bob@example\.org>$/m);
  assert.match(head, /^Cc: carol@example\.org$/m);
  assert.doesNotMatch(head, /^In-Reply-To:/m);
  assert.doesNotMatch(head, /multipart/i);
});

test("composeMessage writes the reply headers it is given", async () => {
  const raw = await composeMessage(
    {
      ...message,
      inReplyTo: "<parent@example.org>",
      references: ["<root@example.org>", "<parent@example.org>"],
    },
    { keepBcc: false },
  );
  const head = headerBlock(raw);
  assert.match(head, /^In-Reply-To: <parent@example\.org>$/m);
  assert.match(head, /^References: <root@example\.org> <parent@example\.org>$/m);
});

test("draftFields parses addresses and keeps one canonical entry each", () => {
  const fields = draftFields({
    to: ['"Bob" <BOB@Example.com>', "  alice+tag@example.org "],
    cc: ['"Quote \\" Name" <q@example.org>'],
    subject: "Re: Hello",
    body: "Text\r\nmore",
    replyToUid: 7,
    replyToFolder: "INBOX",
  });
  assert.deepEqual(fields, {
    to: ['"Bob" <BOB@Example.com>', "alice+tag@example.org"],
    cc: ['"Quote \\" Name" <q@example.org>'],
    bcc: [],
    subject: "Re: Hello",
    body: "Text\r\nmore",
    replyToUid: 7,
    replyToFolder: "INBOX",
  });
  assert.deepEqual(recipientsOf(fields), [
    "bob@example.com",
    "alice+tag@example.org",
    "q@example.org",
  ]);
  // Defaults: no recipients, empty subject and body; a reply folder defaults to INBOX.
  assert.deepEqual(draftFields({}), { to: [], cc: [], bcc: [], subject: "", body: "" });
  assert.equal(draftFields({ replyToUid: 3 }).replyToFolder, "INBOX");
});

test("draftFields refuses header injection and anything but one addr-spec per entry", () => {
  const long = `${"a".repeat(310)}@example.org`;
  const invalid = [
    { subject: "Hi\r\nBcc: x@evil.example" },
    { subject: "Hi\nX: y" },
    { subject: "nul\u0000" },
    { to: ["bob@example.org\r\nBcc: x@evil.example"] },
    { to: ['"Bob\r\nBcc: x@evil.example" <bob@example.org>'] },
    { to: ["a@example.org, b@example.org"] },
    { to: ["group: a@example.org, b@example.org;"] },
    { to: ["not an address"] },
    { to: ["@example.org"] },
    { to: ["bob@"] },
    { to: [long] },
    { to: [""] },
    { cc: ["x"] },
    { bcc: [7] },
    { to: "bob@example.org" },
    {
      to: Array.from({ length: 30 }, (_, i) => `a${i}@example.org`),
      cc: Array.from({ length: 21 }, (_, i) => `c${i}@example.org`),
    },
    { body: "x\u0000" },
    { replyToFolder: "INBOX" },
    { replyToUid: 1, replyToFolder: "IN\r\nBOX" },
  ];
  for (const raw of invalid)
    assert.throws(
      () => draftFields(raw),
      (error) => error.status === 400 && error.key === "invalid",
      JSON.stringify(raw),
    );
});

test("replyHeaders builds the thread from the parent's ids and drops anything else", () => {
  assert.deepEqual(
    replyHeaders({
      messageId: "<p@example.org>",
      references: "<r1@example.org>\r\n <r2@example.org> junk <bad id>",
    }),
    {
      inReplyTo: "<p@example.org>",
      references: ["<r1@example.org>", "<r2@example.org>", "<p@example.org>"],
    },
  );
  // Without References the parent's In-Reply-To starts the chain.
  assert.deepEqual(
    replyHeaders({ messageId: "<p@x>", inReplyTo: "<q@x>", references: "" }),
    { inReplyTo: "<p@x>", references: ["<q@x>", "<p@x>"] },
  );
  assert.deepEqual(replyHeaders({ messageId: "no-brackets\r\nX: y" }), {});
  const many = Array.from({ length: 40 }, (_, i) => `<m${i}@x>`).join(" ");
  assert.equal(
    replyHeaders({ messageId: "<p@x>", references: many }).references.length,
    20,
  );
});
