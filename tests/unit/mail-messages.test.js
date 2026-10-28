import test from "node:test";
import assert from "node:assert/strict";
import {
  attachmentsOf,
  leafParts,
  readMessage,
  textPart,
} from "../../server/features/mail/mail-messages.js";
import { partInfo } from "../../server/features/mail/mail-parts.js";

test("attached mails and attached multiparts are leaves, never descended into", () => {
  const structure = {
    type: "multipart/mixed",
    childNodes: [
      { part: "1", type: "text/html" },
      {
        part: "2",
        type: "message/rfc822",
        childNodes: [{ part: "2", type: "text/plain" }],
      },
      {
        part: "3",
        type: "multipart/report",
        disposition: "attachment",
        dispositionParameters: { filename: "bounce" },
        childNodes: [{ part: "3.1", type: "text/plain" }],
      },
      {
        part: "4",
        type: "multipart/alternative",
        childNodes: [{ part: "4.1", type: "text/plain" }],
      },
    ],
  };
  assert.deepEqual(
    leafParts(structure).map((n) => n.part),
    ["1", "2", "3", "4.1"],
  );
  assert.deepEqual(
    attachmentsOf(structure).map((n) => n.part),
    ["2", "3"],
  );
});

test("one attachment rule: any case of the disposition marks an attachment", () => {
  const structure = {
    type: "multipart/mixed",
    childNodes: [
      { part: "1", type: "text/plain", disposition: "ATTACHMENT" },
      { part: "2", type: "text/html" },
      {
        part: "3",
        type: "multipart/report",
        disposition: "Attachment",
        childNodes: [{ part: "3.1", type: "text/plain" }],
      },
    ],
  };
  // The attached text file is no body, and the attached multipart is one leaf.
  assert.equal(textPart(structure).part, "2");
  assert.deepEqual(
    attachmentsOf(structure).map((n) => n.part),
    ["1", "3"],
  );
});

test("read lists an attachment with the size partInfo estimates", async () => {
  const node = {
    part: "2",
    type: "application/pdf",
    encoding: "BASE64",
    size: 400,
    disposition: "attachment",
    dispositionParameters: { filename: "a.pdf" },
  };
  const client = {
    mailboxOpen: async () => ({}),
    download: async () => ({ content: null }),
    fetchOne: async (uid) => ({
      uid: Number(uid),
      envelope: {},
      bodyStructure: {
        type: "multipart/mixed",
        childNodes: [{ part: "1", type: "text/plain" }, node],
      },
    }),
  };
  const message = await readMessage(client, "INBOX", 9);
  assert.equal(message.attachments[0].size, 300);
  assert.equal(message.attachments[0].size, partInfo(node).size);
});
