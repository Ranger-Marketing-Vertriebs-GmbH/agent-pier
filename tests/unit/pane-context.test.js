import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaneContext, paneId, usePane, usePaneId } from "../../web/lib/pane-context.js";

test("ids keep their value outside a pane and gain the pane prefix inside one", () => {
  assert.equal(paneId(null, "assistant-message"), "assistant-message");
  assert.equal(paneId(undefined, "assistant-message"), "assistant-message");
  assert.equal(
    paneId({ idPrefix: "pane-r1" }, "file-editor-panel"),
    "pane-r1-file-editor-panel",
  );
});

function Probe() {
  const pane = usePane();
  return createElement(
    "i",
    null,
    `${pane?.key ?? "none"}:${usePaneId("file-editor-panel")}`,
  );
}

test("a view outside a pane sees no pane; inside one it sees the pane's ids", () => {
  assert.equal(
    renderToStaticMarkup(createElement(Probe)),
    "<i>none:file-editor-panel</i>",
  );
  const pane = { key: "r1", focused: true, width: 400, height: 300, idPrefix: "pane-r1" };
  assert.equal(
    renderToStaticMarkup(
      createElement(PaneContext.Provider, { value: pane }, createElement(Probe)),
    ),
    "<i>r1:pane-r1-file-editor-panel</i>",
  );
});
