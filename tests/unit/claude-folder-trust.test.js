import test from "node:test";
import assert from "node:assert/strict";
import { folderTrustScreen } from "../../server/features/requests/claude-folder-trust.js";
import {
  folderScreen,
  folderScreenWithWarnings,
} from "../fixtures/requests/claude-folder-trust.js";

test("Claude folder trust requires the complete startup menu and exact workspace", () => {
  assert.deepEqual(folderTrustScreen(folderScreen(), "/fixture/project"), {
    selected: "exit",
  });
  assert.deepEqual(
    folderTrustScreen(folderScreen("/fixture/project", "trust"), "/fixture/project"),
    { selected: "trust" },
  );
  assert.equal(folderTrustScreen(folderScreen(), "/another/project"), null);
  // Quoted in indented output, the dialog's rule and heading are not its own lines.
  assert.equal(
    folderTrustScreen(
      "Assistant output:\n" + folderScreen().replace(/\n/g, "\n  ⎿  "),
      "/fixture/project",
    ),
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
test("settings warnings printed above the dialog do not hide folder trust", () => {
  for (const selected of ["exit", "trust"])
    assert.deepEqual(
      folderTrustScreen(
        folderScreenWithWarnings("/fixture/project", selected),
        "/fixture/project",
      ),
      { selected },
    );
  // A warning that quotes the dialog does not count; the real dialog below does.
  const quoted = folderScreenWithWarnings("/fixture/project", "trust").replace(
    " Settings warnings",
    ` ${"─".repeat(30)}\n Accessing workspace:\n\n /elsewhere\n\n Quick safety check:\n Settings warnings`,
  );
  assert.deepEqual(folderTrustScreen(quoted, "/fixture/project"), { selected: "trust" });
  assert.equal(
    folderTrustScreen(
      folderScreenWithWarnings("/fixture/project") + "\n❯ ",
      "/fixture/project",
    ),
    null,
  );
});
