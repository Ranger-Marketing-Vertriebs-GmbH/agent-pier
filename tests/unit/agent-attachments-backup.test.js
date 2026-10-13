import test from "node:test";
import assert from "node:assert/strict";
import { isAssistantMember } from "../../server/features/operations/assistant-backup.js";

// Attachments are owner files in agent workspaces: backups and restores carry the
// copies and their index (the assistants database) together (docs/backups.md).
test("host backups hold attachment copies together with their index (M8)", () => {
  const agent = "7d1c2a64-6a0e-4c3b-9a43-6a1f2b3c4d5e";
  assert.equal(isAssistantMember("assistants/assistants.sqlite"), true);
  for (const name of [
    "20261013-101500-1a2b3c4d-photo.png",
    "20261013-101500-1a2b3c4d-notes.md",
  ])
    assert.equal(
      isAssistantMember(`assistants/workspaces/${agent}/attachments/${name}`),
      true,
      name,
    );
});
