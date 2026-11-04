import test from "node:test";
import assert from "node:assert/strict";
import { commentInput } from "../../server/features/changes/review-comment-input.js";

const anchor = {
  side: "new",
  line: 3,
  text: "x",
  before: [],
  after: [],
  excerpt: [{ kind: "add", text: "x" }],
};
const valid = (extra = {}) => ({
  workspace: "",
  file: "a.js",
  side: "new",
  line: 3,
  anchor,
  body: "note",
  ...extra,
});
const session = { kind: "session" };

test("a workspace id may climb to a sibling worktree", () => {
  for (const workspace of ["../feat/y", "../../x", ".worktrees/feat/x"])
    assert.equal(commentInput(valid({ workspace }), session).workspace, workspace);
});

test("a workspace id still refuses empty, dot, absolute, backslash and control forms", () => {
  for (const workspace of [
    ".",
    "./a",
    "a/./b",
    "a//b",
    "/abs",
    "a\\b",
    "a\nb",
    "x".repeat(513),
  ])
    assert.throws(() => commentInput(valid({ workspace }), session), { status: 400 });
});

test("a file path keeps refusing parent segments", () => {
  for (const file of ["../x", "a/../b", ".."])
    assert.throws(() => commentInput(valid({ file }), session), { status: 400 });
});
