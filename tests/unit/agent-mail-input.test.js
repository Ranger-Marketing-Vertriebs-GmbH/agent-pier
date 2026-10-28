import test from "node:test";
import assert from "node:assert/strict";
import { mailInput } from "../../server/features/assistants/mail/agent-mail-input.js";
import { readingInput } from "../../server/features/assistants/mail/agent-mail-reading.js";
import { mailDefinition } from "../../server/features/assistants/team-plugin/mail-tool.js";

test("attachments, part, mode and attachmentText pass the schema", () => {
  const input = {
    action: "send",
    accountId: "a",
    to: ["b@example.org"],
    attachments: [{ path: "mail/x.pdf" }, { path: "r.pdf", projectId: "p1" }],
  };
  assert.deepEqual(mailInput(input), input);
  assert.equal(
    mailInput({ action: "attachment", accountId: "a", uid: 3, part: "2.1", mode: "text" })
      .part,
    "2.1",
  );
  assert.equal(
    mailInput({ action: "search", accountId: "a", query: { attachmentText: "49.99" } })
      .query.attachmentText,
    "49.99",
  );
  const save = {
    action: "attachment",
    accountId: "a",
    folder: "INBOX",
    uid: 3,
    part: "1",
    mode: "save",
    projectId: "p1",
    path: "invoices/2026",
  };
  assert.deepEqual(mailInput(save), save);
  const forward = {
    action: "forward",
    accountId: "a",
    uid: 9,
    to: ["b@example.org"],
    includeAttachments: false,
    attachments: [{ path: "notes.txt" }],
  };
  assert.deepEqual(mailInput(forward), forward);
  const draft = {
    action: "draft",
    accountId: "a",
    draftUid: 4,
    removeAttachments: ["old.pdf"],
  };
  assert.deepEqual(mailInput(draft), draft);
});

test("a bad part, mode or attachment entry is invalid", () => {
  for (const bad of [
    { part: "../1" },
    { part: "" },
    { part: "1." },
    { part: "12345" },
    { part: Array.from({ length: 11 }, () => "1").join(".") },
    { mode: "exec" },
    { includeAttachments: "yes" },
    { attachments: [{ path: "x", mode: 1 }] },
    { attachments: [{ projectId: "p1" }] },
    { attachments: [{ path: "" }] },
    { attachments: [{ path: "x".repeat(4097) }] },
    { attachments: ["x"] },
    { attachments: Array.from({ length: 21 }, () => ({ path: "x" })) },
    { removeAttachments: Array.from({ length: 21 }, () => "x") },
    { removeAttachments: ["x".repeat(201)] },
    { projectId: "x".repeat(101) },
    { path: "x".repeat(4097) },
    { query: { attachmentText: "x".repeat(201) } },
  ])
    assert.throws(
      () => mailInput({ action: "attachment", accountId: "a", ...bad }),
      { key: "invalid" },
      JSON.stringify(bad).slice(0, 80),
    );
  // The deepest part number the pattern allows still passes.
  const deep = Array.from({ length: 10 }, () => "9999").join(".");
  assert.equal(
    mailInput({ action: "attachment", accountId: "a", part: deep }).part,
    deep,
  );
  // Twenty attachments are the most a call may name.
  const twenty = Array.from({ length: 20 }, () => ({ path: "x" }));
  assert.equal(
    mailInput({ action: "send", accountId: "a", attachments: twenty }).attachments.length,
    20,
  );
});

test("the schema offers the attachment and forward actions with their fields", () => {
  const { properties } = mailDefinition.mail.parameters;
  for (const action of ["attachment", "forward"])
    assert.ok(properties.action.enum.includes(action), action);
  assert.deepEqual(properties.mode.enum, ["save", "text"]);
  assert.equal(properties.attachments.maxItems, 20);
  assert.deepEqual(properties.attachments.items.required, ["path"]);
  assert.equal(properties.removeAttachments.maxItems, 20);
  assert.equal(properties.includeAttachments.type, "boolean");
  assert.equal(properties.query.properties.attachmentText.maxLength, 200);
  const { description } = mailDefinition.mail;
  for (const code of [
    "MAIL_ATTACHMENT_TOO_LARGE",
    "MAIL_DRAFT_CHANGED",
    "MAIL_TEXT_UNSUPPORTED",
    "MAIL_TEXT_FAILED",
    "MAIL_SOURCE_REFUSED",
    "MAIL_SOURCE_NOT_FOUND",
    "MAIL_SOURCE_EMPTY",
    "MAIL_SAVE_REFUSED",
    "MAIL_BUSY",
  ])
    assert.ok(description.includes(code), code);
  assert.ok(description.includes("htmlBusy"));
  for (const word of ["forward", "attachmentText", "removeAttachments", "untrusted"])
    assert.ok(description.includes(word), word);
});

test("a search by attachment text passes the reading check with its other criteria", () => {
  const request = readingInput({
    action: "search",
    accountId: "a",
    query: { attachmentText: "49.99", since: "2026-10-01" },
  });
  assert.deepEqual(request, {
    action: "search",
    folder: "INBOX",
    limit: 20,
    query: { attachmentText: "49.99", since: "2026-10-01" },
  });
  // Control characters are refused here as in every other criterion.
  assert.throws(
    () =>
      readingInput({
        action: "search",
        accountId: "a",
        query: { attachmentText: "a\0" },
      }),
    { key: "invalid" },
  );
});
