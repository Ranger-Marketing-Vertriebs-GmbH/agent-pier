import test from "node:test";
import assert from "node:assert/strict";
import { attachmentTargets } from "../../server/features/assistants/team-plugin/tool-guard.js";

const scope = { roots: ["/w"], agentId: "ap-a1" };
const names = (toolName, params) => attachmentTargets(toolName, params, scope);

// OpenClaw decodes a file: path with fileURLToPath, so every spelling it reads as the
// agent's attachments/ folder names that folder's file for the bridge.
test("a file: URL into attachments/ names its file in every spelling", () => {
  for (const value of [
    "file:///w/a1/attachments/x.pdf",
    "file://localhost/w/a1/attachments/x.pdf",
    "FILE:///w/a1/attachments/x.pdf",
    "file:///w/a1/%61ttachments/x.pdf",
    "file:///w/a1/%61TTACHMENTS/x.pdf",
    "file:///w/a1/attachments/%78.pdf",
    "file:///w/a1/memory/%2E%2E/attachments/x.pdf",
    "file:///w/a1/memory/%2e%2e/%61ttachments/x.pdf",
    "file:///w/a1/./attachments/x.pdf",
    "file:///w/a1/attachments%5Cx.pdf",
    "@file:///w/a1/%61ttachments/x.pdf",
    " file:///w/a1/%61ttachments/x.pdf ",
  ])
    for (const [tool, params] of [
      ["read", { path: value }],
      ["memory_get", { file_path: value }],
      ["view_image", { image: value }],
      ["pdf", { pdfs: ["notes.pdf", value] }],
      ["write", { filePath: value, content: "x" }],
    ])
      assert.ok(names(tool, params).includes("x.pdf"), `${tool} ${value}`);
});

test("a file: URL to the attachments folder itself or elsewhere stays unresolved", () => {
  assert.deepEqual(names("read", { path: "file:///w/a1/%61ttachments" }), [""]);
  // Another agent's folder or a host outside the workspaces root is never a name of
  // this agent's, and a path that stays out of attachments/ names nothing there.
  assert.deepEqual(names("read", { path: "file:///w/a2/%61ttachments/x.pdf" }), [""]);
  assert.deepEqual(names("read", { path: "file:///w/a1/notes/%78.md" }), []);
  assert.deepEqual(names("read", { path: "file:///w/a1/attachments.md" }), []);
});

test("an undecodable file: value is judged as written", () => {
  // fileURLToPath refuses an encoded "/" and a foreign host; OpenClaw cannot read
  // either, and the written form still counts when it names attachments/.
  assert.deepEqual(names("read", { path: "file:///w/a1/attachments%2Fx.pdf" }), []);
  assert.deepEqual(names("read", { path: "file://host/w/a1/attachments/x.pdf" }), [""]);
  assert.deepEqual(names("read", { path: "file:///w/a1/attachments/x%2F.pdf" }), [""]);
});
