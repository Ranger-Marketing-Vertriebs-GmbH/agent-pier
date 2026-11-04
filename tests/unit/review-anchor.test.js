import test from "node:test";
import assert from "node:assert/strict";
import { parseGitDiff } from "../../server/features/changes/diff-parse.js";
import {
  anchorAt,
  excerptAt,
  locateAnchor,
  placeComments,
  sideOf,
} from "../../server/features/changes/review-anchor.js";

const modified = [
  "diff --git a/server/a.js b/server/a.js",
  "index 1111111..2222222 100644",
  "--- a/server/a.js",
  "+++ b/server/a.js",
  "@@ -40,3 +40,3 @@ function login() {",
  " const user = load();",
  "-if (pw === user.pw) return ok();",
  "+if (await verify(pw, user.hash)) return ok();",
  " return fail();",
].join("\n");

const diffOf = (path, lines, start = 10) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},${lines.length} +${start},${lines.length} @@`,
    ...lines.map((l) => (l.startsWith("-") || l.startsWith("+") ? l : ` ${l}`)),
  ].join("\n");

const rowsOf = (text) => parseGitDiff(text)[0].rows;
const comment = (file, anchor, id = `${file}:${anchor.line}:${anchor.text}`) => ({
  id,
  file,
  anchor,
  body: "x",
  resolved: false,
});

test("sideOf maps row kinds to sides", () => {
  assert.equal(sideOf({ kind: "remove" }), "old");
  assert.equal(sideOf({ kind: "add" }), "new");
  assert.equal(sideOf({ kind: "context" }), "new");
  assert.equal(sideOf({ kind: "meta" }), null);
});

test("an anchor carries side, line, text, context and excerpt", () => {
  const rows = rowsOf(modified);
  assert.deepEqual(anchorAt(rows, 3), {
    side: "new",
    line: 41,
    text: "if (await verify(pw, user.hash)) return ok();",
    before: ["const user = load();"],
    after: ["return fail();"],
    excerpt: [
      { kind: "context", text: "const user = load();" },
      { kind: "remove", text: "if (pw === user.pw) return ok();" },
      { kind: "add", text: "if (await verify(pw, user.hash)) return ok();" },
    ],
  });
  assert.equal(anchorAt(rows, 0), null);
  assert.equal(anchorAt(rows, 99), null);
  assert.equal(anchorAt(rows, 2).side, "old");
  assert.equal(anchorAt(rows, 2).line, 41);
});

test("excerpt clips long text to 200 characters and stays in the hunk", () => {
  const rows = rowsOf(diffOf("a.js", ["x".repeat(500), "b"]));
  const excerpt = excerptAt(rows, 2);
  assert.equal(excerpt[0].text.length, 200);
  assert.equal(excerpt.length, 2);
});

const base = ["a", "b", "c", "target();", "d", "e"];

test("a shifted hunk re-locates the comment by content", () => {
  const anchor = anchorAt(rowsOf(diffOf("a.js", base)), 4);
  const shifted = rowsOf(diffOf("a.js", ["n1", "n2", "n3", "n4", "n5", ...base], 15));
  const index = locateAnchor(shifted, anchor);
  assert.equal(shifted[index].newLine, anchor.line + 5 + 5);
  assert.equal(shifted[index].text, "target();");
});

test("repeated text is disambiguated by context", () => {
  const lines = ["if (a) {", "one();", "}", "if (b) {", "two();", "}"];
  const rows = rowsOf(diffOf("a.js", lines));
  const anchor = anchorAt(rows, 6);
  assert.equal(locateAnchor(rows, anchor), 6);
  // The line number now points at the first brace, the context still wins.
  assert.equal(locateAnchor(rows, { ...anchor, line: anchor.line - 3 }), 6);
});

test("ties are broken by distance to the old line", () => {
  const rows = rowsOf(diffOf("a.js", ["}", "x", "}", "y", "}"]));
  const anchor = { side: "new", line: 12, text: "}", before: [], after: [], excerpt: [] };
  assert.equal(locateAnchor(rows, anchor), 3);
});

test("a line that is gone, or moved to the other side, is not found", () => {
  const anchor = anchorAt(rowsOf(modified), 3);
  const reverted = rowsOf(
    diffOf("server/a.js", ["const user = load();", "-the fix", "return fail();"]),
  );
  assert.equal(locateAnchor(reverted, anchor), null);
  const moved = rowsOf(
    diffOf("server/a.js", ["-if (await verify(pw, user.hash)) return ok();", "z"]),
  );
  assert.equal(locateAnchor(moved, anchor), null);
});

test("placement groups comments by file, outdated and missing", () => {
  const files = parseGitDiff(modified);
  const rows = files[0].rows;
  const live = anchorAt(rows, 3);
  const gone = { ...live, text: "deleted line" };
  const other = comment("other.js", live);
  const { byFile, missing } = placeComments(
    [comment("server/a.js", live, "1"), comment("server/a.js", gone, "2"), other],
    files,
  );
  assert.equal(byFile.get("server/a.js").placed.length, 1);
  assert.equal(byFile.get("server/a.js").placed[0].index, 3);
  assert.equal(byFile.get("server/a.js").outdated.length, 1);
  assert.deepEqual(
    missing.map((c) => c.file),
    ["other.js"],
  );
  assert.equal(byFile.has("other.js"), false);
});

test("resolved comments are placed like open ones", () => {
  const files = parseGitDiff(modified);
  const c = { ...comment("server/a.js", anchorAt(files[0].rows, 3)), resolved: true };
  assert.equal(placeComments([c], files).byFile.get("server/a.js").placed.length, 1);
});
