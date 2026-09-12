import test from "node:test";
import assert from "node:assert/strict";
import { folderTrustScreen } from "../../server/features/requests/claude-folder-trust.js";
import { folderScreen } from "../fixtures/requests/claude-folder-trust.js";

test("Claude folder trust requires the complete startup menu and exact workspace", () => {
  assert.deepEqual(folderTrustScreen(folderScreen(), "/fixture/project"), {
    selected: "exit",
  });
  assert.deepEqual(
    folderTrustScreen(folderScreen("/fixture/project", "trust"), "/fixture/project"),
    { selected: "trust" },
  );
  assert.equal(folderTrustScreen(folderScreen(), "/another/project"), null);
  assert.equal(
    folderTrustScreen("Assistant output:\n" + folderScreen(), "/fixture/project"),
    null,
  );
  assert.equal(
    folderTrustScreen(folderScreen() + "\n❯ New composer", "/fixture/project"),
    null,
  );
  assert.equal(
    folderTrustScreen(folderScreen().replace("No, exit", "No"), "/fixture/project"),
    null,
  );
});
test("wrapped Claude workspace paths retain meaningful spaces", () => {
  assert.ok(folderTrustScreen(folderScreen("/long/pro\n ject"), "/long/project"));
  assert.ok(folderTrustScreen(folderScreen("/long/my\n project"), "/long/my project"));
  assert.equal(
    folderTrustScreen(folderScreen("/long/my project"), "/long/myproject"),
    null,
  );
  assert.equal(
    folderTrustScreen(folderScreen("/long/myproject"), "/long/my project"),
    null,
  );
});
