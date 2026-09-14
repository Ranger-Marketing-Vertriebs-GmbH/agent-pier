import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { loadLanguage } from "../../web/features/files/file-editor-languages.js";
import { editorReducer } from "../../web/features/files/file-editor-state.js";

for (const [extension, source] of Object.entries({
  js: "const value = 1",
  jsx: "<div />",
  ts: "const n: number = 1",
  tsx: "<div />",
  json: '{"a":1}',
  html: "<html></html>",
  css: "a { color: red; }",
  md: "# Title",
  py: "value = 1",
  yaml: "value: true",
  sh: "echo hello",
  toml: "value = 1",
})) {
  test(`installed ${extension} language exports produce a compatible parser`, async () => {
    const extensionSupport = await loadLanguage(`file.${extension}`);
    const state = EditorState.create({ doc: source, extensions: [extensionSupport] });
    assert.ok(syntaxTree(state).length > 0);
  });
}
test("unknown text requires no language extension", async () =>
  assert.deepEqual(await loadLanguage("file.unknown"), []));
test("full EditorState retains selection-only changes and undo/redo across reducer tab switches", () => {
  let current = EditorState.create({ doc: "baseline", extensions: [history()] });
  current = current.update({ changes: { from: 8, insert: " draft" } }).state;
  current = current.update({ selection: { anchor: 3 } }).state;
  let state = {
    tabs: [
      {
        id: "a",
        text: "baseline draft",
        baselineText: "baseline",
        format: {},
        baselineFormat: {},
      },
      { id: "b" },
    ],
    activeId: "a",
  };
  state = editorReducer(state, {
    type: "edit",
    id: "a",
    patch: { editorState: current, scrollTop: 80 },
  });
  state = editorReducer(state, { type: "activate", id: "b" });
  state = editorReducer(state, { type: "activate", id: "a" });
  current = state.tabs[0].editorState;
  assert.equal(current.selection.main.anchor, 3);
  assert.equal(state.tabs[0].scrollTop, 80);
  const target = {
    get state() {
      return current;
    },
    dispatch(transaction) {
      current = transaction.state;
    },
  };
  assert.equal(undo(target), true);
  assert.equal(current.doc.toString(), "baseline");
  assert.equal(redo(target), true);
  assert.equal(current.doc.toString(), "baseline draft");
});

test("a historical save completion cannot replace a newer baseline or its current outcome", () => {
  const attempt = {
    baselineGeneration: 0,
    text: "old attempted text",
    format: { bom: false, lineEnding: "lf" },
  };
  const document = {
    revision: `d1:${"3".repeat(64)}`,
    metadataRevision: `e1:${"3".repeat(64)}`,
  };
  const outcome = { status: "failed", error: { code: "FILE_CONFLICT_CHANGED" } };
  const tab = {
    id: "same-open-generation",
    baselineGeneration: 1,
    attempt,
    document,
    text: "newer draft",
    baselineText: "newer saved version",
    dirty: true,
    outcome,
  };
  const next = editorReducer(
    { tabs: [tab], activeId: tab.id },
    {
      type: "saved",
      id: tab.id,
      attempt,
      result: {
        revision: `d1:${"2".repeat(64)}`,
        metadataRevision: `e1:${"2".repeat(64)}`,
      },
    },
  );
  assert.equal(next.tabs[0], tab);
  assert.equal(next.tabs[0].document, document);
  assert.equal(next.tabs[0].outcome, outcome);
  assert.equal(next.tabs[0].dirty, true);
});
