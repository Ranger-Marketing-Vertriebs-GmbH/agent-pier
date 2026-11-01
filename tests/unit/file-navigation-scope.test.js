import test from "node:test";
import assert from "node:assert/strict";
import { concernsScope } from "../../web/features/files/file-navigation-decision.js";

test("a request concerns a scope unless it names another pane", () => {
  assert.equal(concernsScope({ reason: "application" }, "pane-1"), true);
  assert.equal(
    concernsScope({ reason: "pane-close", paneScope: "pane-1" }, "pane-1"),
    true,
  );
  assert.equal(
    concernsScope({ reason: "pane-close", paneScope: "pane-2" }, "pane-1"),
    false,
  );
  assert.equal(
    concernsScope({ reason: "pane-close", paneScope: "pane-2" }, undefined),
    false,
  );
  assert.equal(concernsScope({ reason: "application" }, undefined), true);
  assert.equal(concernsScope(undefined, "pane-1"), true);
});
