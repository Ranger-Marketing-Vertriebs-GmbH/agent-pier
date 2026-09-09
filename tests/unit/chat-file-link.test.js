import test from "node:test";
import assert from "node:assert/strict";
import { projectLinkPath } from "../../web/features/chat/chat-file-link.js";

test("project links preserve file names and only strip the exact project prefix", () => {
  assert.equal(projectLinkPath("/work/repo/docs/a.md:12:3", "/work/repo"), "docs/a.md");
  assert.equal(
    projectLinkPath("file:///work/repo/docs/a%20b.md#L12", "/work/repo"),
    "docs/a b.md",
  );
  assert.equal(projectLinkPath("./docs/a%23b.md", "/work/repo"), "docs/a#b.md");
  assert.equal(
    projectLinkPath("/work/repo-other/a.md", "/work/repo"),
    "/work/repo-other/a.md",
  );
  assert.equal(projectLinkPath("../secret", "/work/repo"), "../secret");
});
test("web, mail, fragment and unsafe scheme URLs are not treated as project files", () => {
  for (const link of [
    "https://example.com/a",
    "//example.com/a",
    "mailto:a@example.com",
    "#heading",
    "javascript:alert(1)",
    "data:text/html,bad",
    "file://other-host/etc/a",
    "",
  ])
    assert.equal(projectLinkPath(link, "/work/repo"), null);
});
