import test from "node:test";
import assert from "node:assert/strict";
import {
  attachmentName,
  userAttachments,
} from "../../web/features/chat/user-attachments.js";

const data = "/Users/me/Library/Application Support/AgentPier";
const note = `${data}/chat-attachments/acc-1/sess-1/file-Ab12cd/note.txt`;
const image = `${data}/chat-attachments/acc-1/sess-1/20261120T083415-ad8ce264.png`;

test("the composer's trailing attachment paths become chips", () => {
  assert.deepEqual(userAttachments(`Read this\n${note}\n${image}`), {
    text: "Read this",
    files: [
      { path: note, name: "note.txt" },
      { path: image, name: "20261120T083415-ad8ce264.png" },
    ],
  });
  // An attachment-only message keeps no text.
  assert.deepEqual(userAttachments(note), {
    text: "",
    files: [{ path: note, name: "note.txt" }],
  });
});

test("images the chat already shows are not repeated as chips", () => {
  assert.deepEqual(userAttachments(`Look\n${note}\n${image}`, [{ path: image }]), {
    text: "Look",
    files: [{ path: note, name: "note.txt" }],
  });
});

test("paths the user typed in the middle or outside the attachment folder stay text", () => {
  const typed = `See ${note} please`;
  assert.deepEqual(userAttachments(typed), { text: typed, files: [] });
  const middle = `${note}\nand then`;
  assert.deepEqual(userAttachments(middle), { text: middle, files: [] });
  const other = "Check\n/work/project/chat-attachments.md";
  assert.deepEqual(userAttachments(other), { text: other, files: [] });
  assert.deepEqual(userAttachments(""), { text: "", files: [] });
  assert.deepEqual(userAttachments(undefined), { text: "", files: [] });
});

test("an attachment name is the file name without its folders", () => {
  assert.equal(attachmentName(note), "note.txt");
  assert.equal(attachmentName("/tmp/plain.png"), "plain.png");
  assert.equal(attachmentName("plain.png"), "plain.png");
  // A legacy folder without the account level is an attachment too.
  assert.deepEqual(
    userAttachments(`x
${data}/chat-attachments/sess/file-1/a b.md`).files,
    [{ path: `${data}/chat-attachments/sess/file-1/a b.md`, name: "a b.md" }],
  );
});
