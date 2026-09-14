import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { history, undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { requiresEditorRetention } from "../../web/features/files/file-editor-state.js";
import { createFileEditorStore } from "../../web/features/files/file-editor-store.js";

for (const lostReply of [false, true]) {
  test(`close retains ${lostReply ? "unresolved" : "pending"} attempt after real undo to baseline`, async () => {
    let resolve;
    const reply = new Promise((done) => {
      resolve = done;
    });
    const requests = [];
    const result = {
      path: "/a",
      revision: `d1:${"2".repeat(64)}`,
      metadataRevision: `e1:${"2".repeat(64)}`,
    };
    const store = createFileEditorStore();
    const tab = await store.open(
      {
        readText: async () => ({
          ...result,
          text: "original",
          bom: false,
          lineEnding: "lf",
          readOnly: false,
        }),
        saveText: async (path, bytes, options) => {
          requests.push({ path, bytes: [...bytes], ...options });
          if (lostReply && requests.length === 1)
            throw Object.assign(new Error("lost reply"), {
              code: "FILE_INVALID_RESPONSE",
            });
          return reply;
        },
      },
      "scope",
      "/a",
    );
    let state = EditorState.create({ doc: "original", extensions: [history()] });
    const dispatch = (transaction) => {
      state = transaction.state;
      store.edit(tab.id, {
        text: state.doc.toString(),
        editorState: state,
        scrollTop: 73,
      });
    };
    dispatch(
      state.update({
        changes: { from: 8, insert: " changed" },
        selection: { anchor: 16 },
      }),
    );
    const saving = store.save(tab.id);
    if (lostReply) assert.equal((await saving).error.code, "FILE_INVALID_RESPONSE");
    const attempt = store.getSnapshot().tabs[0].attempt;
    assert.equal(undo({ state, dispatch }), true);
    const retainedState = state;
    assert.equal(store.getSnapshot().tabs[0].dirty, false);
    assert.equal(
      store.close(tab.id).status,
      lostReply ? "close-unresolved" : "close-pending",
    );
    let current = store.getSnapshot().tabs[0];
    assert.equal(current.attempt, attempt);
    assert.equal(requiresEditorRetention(current), true);
    assert.equal(current.editorState, retainedState);
    assert.equal(current.text, "original");
    assert.equal(current.scrollTop, 73);
    assert.equal(redoDepth(current.editorState), 1);
    assert.equal(undoDepth(current.editorState), 0);
    assert.equal(requests.length, 1);
    let completion = saving;
    if (lostReply) {
      assert.equal(redo({ state, dispatch }), true);
      completion = store.save(tab.id);
      assert.equal(undo({ state, dispatch }), true);
      assert.deepEqual(requests[1], requests[0]);
    }
    const latest = state;
    resolve(result);
    assert.equal((await completion).status, "updated-during-save");
    current = store.getSnapshot().tabs[0];
    assert.equal(current.editorState, latest);
    assert.equal(current.text, "original");
    assert.equal(current.baselineText, "original changed");
    assert.equal(current.attempt, null);
    assert.equal(current.dirty, true);
    assert.equal(store.close(tab.id).status, "dirty");
    assert.equal(redo({ state, dispatch }), true);
    assert.equal(store.getSnapshot().tabs[0].dirty, false);
    assert.equal(requiresEditorRetention(store.getSnapshot().tabs[0]), false);
    assert.equal(store.close(tab.id).status, "closed");
  });
}

test("only explicit discard bypasses unresolved close retention", async () => {
  const store = createFileEditorStore();
  const tab = await store.open(
    {
      readText: async () => ({
        path: "/a",
        text: "a",
        revision: `d1:${"1".repeat(64)}`,
        metadataRevision: `e1:${"1".repeat(64)}`,
        bom: false,
        lineEnding: "lf",
      }),
      saveText: async () => {
        throw Object.assign(new Error("refused"), { code: "FILE_METADATA_UNSUPPORTED" });
      },
    },
    "scope",
    "/a",
  );
  await store.save(tab.id);
  assert.equal(store.getSnapshot().tabs[0].dirty, false);
  assert.equal(store.close(tab.id).status, "close-unresolved");
  assert.equal(store.getSnapshot().tabs[0].error.code, "FILE_METADATA_UNSUPPORTED");
  assert.equal(store.close(tab.id, { discard: true }).status, "closed");
  assert.equal(store.getSnapshot().tabs.length, 0);
});
