import test from "node:test";
import assert from "node:assert/strict";
import { parseGitDiff } from "../../server/features/changes/diff-parse.js";

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

const multiFileFixture = [
  "diff --git a/added.js b/added.js",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/added.js",
  "@@ -0,0 +1,2 @@",
  "+one",
  "+two",
  "diff --git a/gone.js b/gone.js",
  "deleted file mode 100644",
  "index 1111111..0000000",
  "--- a/gone.js",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/old.js b/new.js",
  "similarity index 90%",
  "rename from old.js",
  "rename to new.js",
  "index 1111111..2222222 100644",
  "--- a/old.js",
  "+++ b/new.js",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "diff --git a/img.png b/img.png",
  "index 1111111..2222222 100644",
  "Binary files a/img.png and b/img.png differ",
  "diff --git a/run.sh b/run.sh",
  "old mode 100644",
  "new mode 100755",
].join("\n");

const newlineFixture = [
  "diff --git a/n.txt b/n.txt",
  "--- a/n.txt",
  "+++ b/n.txt",
  "@@ -1,3 +1,3 @@",
  "-crlf line\r",
  "+new line",
  " ",
  " tail",
  "\\ No newline at end of file",
].join("\n");

const fileWithRows = (n) =>
  [
    "diff --git a/big.txt b/big.txt",
    "--- a/big.txt",
    "+++ b/big.txt",
    `@@ -0,0 +1,${n} @@`,
    ...Array.from({ length: n }, (_, i) => `+line ${i}`),
  ].join("\n");

test("a modified file gets coordinates and counts", () => {
  const [file] = parseGitDiff(modified);
  assert.equal(file.path, "server/a.js");
  assert.equal(file.status, "modified");
  assert.deepEqual([file.added, file.removed], [1, 1]);
  assert.deepEqual(file.rows[0], {
    kind: "meta",
    text: "@@ -40,3 +40,3 @@ function login() {",
  });
  assert.deepEqual(file.rows[2], {
    kind: "remove",
    text: "if (pw === user.pw) return ok();",
    oldLine: 41,
  });
  assert.deepEqual(file.rows[3], {
    kind: "add",
    text: "if (await verify(pw, user.hash)) return ok();",
    newLine: 41,
  });
  assert.deepEqual(file.rows[4], {
    kind: "context",
    text: "return fail();",
    oldLine: 42,
    newLine: 42,
  });
});

test("added, deleted, renamed, binary and mode-only files", () => {
  const files = parseGitDiff(multiFileFixture);
  assert.deepEqual(
    files.map((f) => [f.path, f.status]),
    [
      ["added.js", "added"],
      ["gone.js", "deleted"],
      ["new.js", "renamed"],
      ["img.png", "modified"],
      ["run.sh", "modified"],
    ],
  );
  assert.equal(files[2].oldPath, "old.js");
  assert.equal(files[0].oldPath, null);
  assert.equal(files[3].binary, true);
  assert.deepEqual(files[3].rows, []);
  assert.deepEqual(files[4].rows, []);
});

test("quoted and spaced paths", () => {
  const files = parseGitDiff(
    'diff --git "a/dir/a\\tb.js" "b/dir/a\\tb.js"\n--- "a/dir/a\\tb.js"\n+++ "b/dir/a\\tb.js"\n@@ -1 +1 @@\n-x\n+y\n' +
      "diff --git a/my file ü.md b/my file ü.md\n--- a/my file ü.md\t\n+++ b/my file ü.md\t\n@@ -1 +1 @@\n-a\n+b\n",
  );
  assert.deepEqual(
    files.map((f) => f.path),
    ["dir/a\tb.js", "my file ü.md"],
  );
});

test("octal escapes decode as UTF-8 and the TAB git appends is stripped", () => {
  const [quoted, plain] = parseGitDiff(
    'diff --git "a/\\303\\274.md" "b/\\303\\274.md"\n--- "a/\\303\\274.md"\n+++ "b/\\303\\274.md"\n@@ -1 +1 @@\n-a\n+b\n' +
      "diff --git a/x y.md b/x y.md\n--- a/x y.md\t\n+++ b/x y.md\t\n@@ -1 +1 @@\n-a\n+b\n",
  );
  assert.equal(quoted.path, "ü.md");
  assert.equal(plain.path, "x y.md");
});

test("a binary or mode-only file takes its path from the diff line", () => {
  const files = parseGitDiff(
    "diff --git a/dir/my img.png b/dir/my img.png\nBinary files a/dir/my img.png and b/dir/my img.png differ\n",
  );
  assert.equal(files[0].path, "dir/my img.png");
});

test("a removed line starting with dashes is a row, not a header", () => {
  const [file] = parseGitDiff(
    "diff --git a/a.sql b/a.sql\n--- a/a.sql\n+++ b/a.sql\n@@ -1,2 +1,2 @@\n--- comment\n+++ comment\n ok\n",
  );
  assert.equal(file.path, "a.sql");
  assert.deepEqual([file.added, file.removed], [1, 1]);
  assert.equal(file.rows[1].text, "-- comment");
});

test("no-newline markers, CRLF and empty lines survive", () => {
  const [file] = parseGitDiff(newlineFixture);
  assert.deepEqual(file.rows.at(-1), {
    kind: "meta",
    text: "\\ No newline at end of file",
  });
  assert.equal(file.rows.find((r) => r.kind === "remove").text, "crlf line");
  assert.ok(file.rows.some((r) => r.kind === "context" && r.text === ""));
});

test("rows stop at the per-file bound and the cut input never throws", () => {
  const big = parseGitDiff(fileWithRows(2500), { maxRowsPerFile: 2000 })[0];
  assert.equal(big.rows.length, 2000);
  assert.equal(big.rowsTruncated, true);
  assert.equal(big.added, 2500);
  const cut = parseGitDiff(modified.split("\n").slice(0, 7).join("\n"));
  assert.equal(cut[0].rows.length, 3);
  assert.deepEqual(parseGitDiff(""), []);
});
