import test from "node:test";
import assert from "node:assert/strict";
import { parseGitDiff } from "../../server/features/changes/diff-parse.js";
import { anchorAt, placeComments } from "../../server/features/changes/review-anchor.js";
import { MAX_COMMENT_BYTES as SERVER_MAX } from "../../server/features/changes/review-comment-input.js";
import {
  MAX_COMMENT_BYTES,
  ROW_PAGE,
  commentInput,
  editorKey,
  editorState,
  fileCommentLayout,
  initialSelection,
  rowLine,
  selectRow,
  selectionAction,
  selectionKey,
} from "../../web/components/diff/diff-review-state.js";

const diff = [
  "diff --git a/server/a.js b/server/a.js",
  "--- a/server/a.js",
  "+++ b/server/a.js",
  "@@ -40,3 +40,3 @@ function login() {",
  " const user = load();",
  "-if (pw === user.pw) return ok();",
  "+if (await verify(pw, user.hash)) return ok();",
  " return fail();",
  "\\ No newline at end of file",
].join("\n");
const [file] = parseGitDiff(diff);
const rows = file.rows; // 0 meta, 1 context 40, 2 remove 41, 3 add 41, 4 context 42, 5 meta

const comment = (index, id = `c${index}`, extra = {}) => ({
  id,
  workspace: "/w",
  file: file.path,
  side: anchorAt(rows, index).side,
  line: anchorAt(rows, index).line,
  anchor: anchorAt(rows, index),
  body: "x",
  status: "open",
  createdAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T00:00:00.000Z",
  sentIn: null,
  ...extra,
});

test("the editor limit matches the server limit", () => {
  assert.equal(MAX_COMMENT_BYTES, SERVER_MAX);
  assert.equal(ROW_PAGE, 400);
});

test("editor state blocks blank and oversized bodies and shows the count near the limit", () => {
  assert.deepEqual(editorState("  \n "), {
    bytes: 4,
    blank: true,
    tooLong: false,
    nearLimit: false,
    canSave: false,
  });
  assert.equal(editorState("Fix it").canSave, true);
  // Bytes, not characters: "ä" is two UTF-8 bytes.
  const near = editorState("ä".repeat(3800));
  assert.equal(near.bytes, 7600);
  assert.equal(near.nearLimit, true);
  assert.equal(near.canSave, true);
  assert.equal(editorState("a".repeat(MAX_COMMENT_BYTES)).canSave, true);
  const over = editorState("a".repeat(MAX_COMMENT_BYTES + 1));
  assert.equal(over.tooLong, true);
  assert.equal(over.canSave, false);
});

test("editor keys: Cmd/Ctrl+Enter saves, Escape cancels, composition is ignored", () => {
  assert.equal(editorKey({ key: "Enter", metaKey: true }), "save");
  assert.equal(editorKey({ key: "Enter", ctrlKey: true }), "save");
  assert.equal(editorKey({ key: "Enter" }), null);
  assert.equal(editorKey({ key: "Escape" }), "cancel");
  assert.equal(editorKey({ key: "Enter", ctrlKey: true, isComposing: true }), null);
  assert.equal(editorKey({ key: "a", ctrlKey: true }), null);
});

test("arrow keys move the selection over code rows and skip meta rows", () => {
  let state = initialSelection;
  state = selectionKey(state, "ArrowDown", rows);
  assert.deepEqual(state, { selected: 1, open: false, editing: false });
  state = selectionKey(state, "ArrowDown", rows);
  assert.equal(state.selected, 2);
  state = selectionKey(state, "End", rows);
  assert.equal(state.selected, 4, "the trailing meta row is skipped");
  assert.equal(selectionKey(state, "ArrowDown", rows).selected, 4, "stays at the end");
  state = selectionKey(state, "Home", rows);
  assert.equal(state.selected, 1);
  assert.equal(selectionKey(state, "ArrowUp", rows).selected, 1, "stays at the start");
  assert.equal(selectionKey(initialSelection, "ArrowUp", rows).selected, 4);
  assert.equal(selectionKey(state, "a", rows), null, "other keys are not handled");
  assert.equal(selectionKey(initialSelection, "ArrowDown", [rows[0]]), null);
});

test("Enter opens the comment action of the selected row, Escape closes it", () => {
  assert.equal(selectionKey(initialSelection, "Enter", rows), null);
  const selected = selectionKey(initialSelection, "ArrowDown", rows);
  const open = selectionKey(selected, "Enter", rows);
  assert.deepEqual(open, { selected: 1, open: true, editing: false });
  assert.deepEqual(selectionKey(open, "Escape", rows), {
    selected: 1,
    open: false,
    editing: false,
  });
  assert.equal(selectionKey(selected, "Escape", rows), null);
  const moved = selectionKey(open, "ArrowDown", rows);
  assert.deepEqual(moved, { selected: 2, open: false, editing: false });
});

test("a tap selects and opens a code row; meta rows are not selectable", () => {
  assert.deepEqual(selectRow(initialSelection, 3, rows), {
    selected: 3,
    open: true,
    editing: false,
  });
  assert.equal(selectRow(initialSelection, 0, rows), initialSelection);
});

test("while the editor is open the selection does not move", () => {
  const open = selectRow(initialSelection, 3, rows);
  const editing = selectionAction(open, "edit");
  assert.deepEqual(editing, { selected: 3, open: true, editing: true });
  assert.equal(selectRow(editing, 1, rows), editing);
  assert.equal(selectionKey(editing, "ArrowDown", rows), null);
  assert.deepEqual(selectionAction(editing, "close"), {
    selected: 3,
    open: false,
    editing: false,
  });
  assert.equal(selectionAction(initialSelection, "edit"), initialSelection);
});

test("rowLine names the line on the row's side", () => {
  assert.equal(rowLine(rows[1]), 40);
  assert.equal(rowLine(rows[2]), 41);
  assert.equal(rowLine(rows[3]), 41);
  assert.equal(rowLine(rows[0]), null);
});

test("commentInput builds the create payload from the anchor", () => {
  assert.deepEqual(commentInput({ workspace: "/w", file, index: 3, body: "Hi" }), {
    workspace: "/w",
    file: "server/a.js",
    side: "new",
    line: 41,
    anchor: anchorAt(rows, 3),
    body: "Hi",
  });
});

test("layout places threads after shown rows and lists hidden and outdated ones", () => {
  const gone = comment(3, "gone", {
    anchor: { ...anchorAt(rows, 3), text: "no longer here" },
  });
  const resolved = comment(1, "resolved", { status: "resolved" });
  const { byFile } = placeComments(
    [comment(3, "a"), comment(3, "b"), resolved, comment(4, "far"), gone],
    [file],
  );
  const layout = fileCommentLayout(byFile.get(file.path), rows, 4);
  assert.deepEqual(
    [...layout.after].map(([index, list]) => [index, list.map((c) => c.id)]),
    [
      [3, ["a", "b"]],
      [1, ["resolved"]],
    ],
  );
  // The anchor row exists but is past the shown page: listed with its line, not outdated.
  assert.deepEqual(
    layout.hidden.map((h) => [h.comment.id, h.line]),
    [["far", 42]],
  );
  assert.deepEqual(
    layout.outdated.map((c) => c.id),
    ["gone"],
  );
});

test("layout of a file without comments is empty", () => {
  const layout = fileCommentLayout(undefined, rows, rows.length);
  assert.equal(layout.after.size, 0);
  assert.deepEqual(layout.hidden, []);
  assert.deepEqual(layout.outdated, []);
});
