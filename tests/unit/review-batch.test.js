import test from "node:test";
import assert from "node:assert/strict";
import { parseGitDiff } from "../../server/features/changes/diff-parse.js";
import { anchorAt } from "../../server/features/changes/review-anchor.js";
import {
  REVIEW_FEEDBACK_LIMIT,
  combineFeedback,
  formatReviewBatch,
  reviewEntries,
} from "../../server/features/changes/review-batch.js";

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

const entry = {
  id: "c1",
  location: "server/a.js",
  line: 41,
  outdated: false,
  excerpt: [{ kind: "add", text: "x" }],
  body: "Fix this.",
};

const anchor = anchorAt(parseGitDiff(modified)[0].rows, 3);
const make = (file, extra = {}) => ({
  id: `${file}:${extra.status ?? "open"}`,
  file,
  workspace: "",
  anchor,
  body: "note",
  resolved: false,
  status: "open",
  ...extra,
});
const open = (file, extra) => make(file, extra);
const resolved = (file) => make(file, { status: "resolved", resolved: true });

test("the batch carries location, line, excerpt and comment", () => {
  const text = formatReviewBatch([
    {
      id: "c1",
      location: ".worktrees/feat/x/server/a.js",
      line: 42,
      outdated: false,
      excerpt: [
        { kind: "remove", text: "if (pw === user.pw) return ok();" },
        { kind: "add", text: "if (await verify(pw, user.hash)) return ok();" },
      ],
      body: "Use a constant-time comparison here.",
    },
  ]);
  assert.equal(
    text,
    [
      "Review notes (1):",
      "Paths are relative to the session directory (for runs: the run's workspace).",
      "",
      "1. .worktrees/feat/x/server/a.js:42",
      "   ```",
      "   - if (pw === user.pw) return ok();",
      "   + if (await verify(pw, user.hash)) return ok();",
      "   ```",
      "   Use a constant-time comparison here.",
    ].join("\n"),
  );
});

test("comments on removed lines are tagged", () => {
  assert.match(
    formatReviewBatch([{ ...entry, side: "old", line: 40 }]),
    /^1\. server\/a\.js:40 \(removed line\)$/m,
  );
  assert.doesNotMatch(formatReviewBatch([{ ...entry, side: "new" }]), /removed line/);
  const [e] = reviewEntries(
    [open("server/a.js", { anchor: anchorAt(parseGitDiff(modified)[0].rows, 2) })],
    new Map([["", parseGitDiff(modified)]]),
  );
  assert.equal(e.side, "old");
});

test("outdated comments are marked and keep their anchor's line", () => {
  assert.match(
    formatReviewBatch([{ ...entry, outdated: true, line: 41 }]),
    /^1\. server\/a\.js:41 \(outdated\)$/m,
  );
});

test("context rows are indented by two spaces", () => {
  const text = formatReviewBatch([
    { ...entry, excerpt: [{ kind: "context", text: "keep" }] },
  ]);
  assert.match(text, /^ {3} {2}keep$/m);
});

test("fences escalate past backticks in the excerpt", () => {
  const text = formatReviewBatch([
    { ...entry, excerpt: [{ kind: "context", text: "```js" }] },
  ]);
  assert.match(text, /^ {3}````$/m);
});

test("fences escalate past backticks in the body", () => {
  const text = formatReviewBatch([{ ...entry, body: "Try:\n```js\nx()\n```" }]);
  assert.match(text, /^ {3}````$/m);
  assert.equal(text.match(/^ {3}````$/gm).length, 2);
});

test("multi-line bodies are indented and entries are numbered in order", () => {
  const text = formatReviewBatch([
    { ...entry, id: "b", location: "b.js", body: "first line\nsecond line" },
    { ...entry, id: "a", location: "a.js" },
  ]);
  assert.match(text, /^Review notes \(2\):/);
  assert.match(text, /^ {3}second line$/m);
  assert.match(text, /^1\. b\.js:41$/m);
  assert.match(text, /^2\. a\.js:41$/m);
  assert.match(text, /\n\n2\. a\.js/);
});

test("no entries give an empty batch", () => {
  assert.equal(formatReviewBatch([]), "");
});

test("entries come from open comments only, relocated against the diff", () => {
  const entries = reviewEntries(
    [open("server/a.js"), resolved("server/a.js"), open("gone.js")],
    new Map([["", parseGitDiff(modified)]]),
  );
  assert.deepEqual(
    entries.map((e) => [e.location, e.outdated]),
    [
      ["gone.js", true],
      ["server/a.js", false],
    ],
  );
  assert.equal(entries[1].line, 41);
});

test("a workspace without a diff counts as outdated and sorts after the root", () => {
  const entries = reviewEntries(
    [
      open("z.js", { workspace: ".worktrees/w" }),
      open("server/a.js"),
      open("a.js", { workspace: ".worktrees/w" }),
    ],
    new Map([["", parseGitDiff(modified)]]),
  );
  assert.deepEqual(
    entries.map((e) => [e.location, e.outdated]),
    [
      ["server/a.js", false],
      [".worktrees/w/a.js", true],
      [".worktrees/w/z.js", true],
    ],
  );
});

test("a located comment reports the current line and excerpt", () => {
  const moved = modified.replace("@@ -40,3 +40,3 @@", "@@ -50,3 +60,3 @@");
  const [e] = reviewEntries([open("server/a.js")], new Map([["", parseGitDiff(moved)]]));
  assert.equal(e.line, 61);
  assert.equal(e.outdated, false);
  assert.equal(e.excerpt.at(-1).kind, "add");
});

test("free text comes first and empty parts disappear", () => {
  assert.equal(
    combineFeedback(" Fix tests. ", "Review notes (1):\n…"),
    "Fix tests.\n\nReview notes (1):\n…",
  );
  assert.equal(combineFeedback("", ""), "");
  assert.equal(combineFeedback("", " batch "), "batch");
  assert.equal(combineFeedback(null, " batch "), "batch");
  assert.equal(combineFeedback("Fix.", undefined), "Fix.");
  assert.equal(combineFeedback(undefined, null), "");
});

test("the feedback limit is the gate's 32 KiB", () => {
  assert.equal(REVIEW_FEEDBACK_LIMIT, 32768);
});

test("a comment with a malformed anchor becomes outdated instead of throwing", () => {
  const entries = reviewEntries(
    [open("server/a.js", { anchor: { side: "new" } })],
    new Map([["", parseGitDiff(modified)]]),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outdated, true);
});
