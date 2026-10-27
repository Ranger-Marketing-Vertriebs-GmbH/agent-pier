import test from "node:test";
import assert from "node:assert/strict";
import { attachmentsOf, leafParts } from "../../server/features/mail/mail-messages.js";

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
