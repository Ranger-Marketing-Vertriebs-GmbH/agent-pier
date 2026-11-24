import assert from "node:assert/strict";
import test from "node:test";
import { withLanguage } from "../../web/lib/i18n/index.js";
import {
  dependencyTitles,
  planTitles,
  statusText,
  statusTone,
  statusBreakdown,
} from "../../web/features/autopilot/order-presentation.js";

test("dependencies resolve against the displayed plan while preserving unknown IDs", () => {
  const draft = [
    {
      id: "prepare",
      title: "Stage data",
      items: [{ id: "import", title: "Import rows" }],
    },
    { id: null, title: "Review" },
  ];
  const approved = [{ id: "prepare", title: "Load production data" }];
  const refs = ["import", "prepare", "external"];
  assert.deepEqual(dependencyTitles(refs, planTitles(draft)), [
    "Import rows",
    "Stage data",
    "external",
  ]);
  assert.deepEqual(dependencyTitles(refs, planTitles(approved)), [
    "import",
    "Load production data",
    "external",
  ]);
});

test("status labels follow the language and retain an external system's exact state", () => {
  withLanguage("en", () => {
    assert.equal(statusText("waiting"), "Waiting");
    assert.equal(statusText("Custom QA"), "Custom QA");
    assert.equal(statusText("constructor"), "constructor");
    assert.equal(statusText(null), "Unknown");
    assert.equal(statusTone("Custom QA"), "neutral");
    assert.equal(statusTone("constructor"), "neutral");
    assert.equal(statusTone("completed"), "ok");
    assert.equal(
      statusBreakdown({ byStatus: { waiting: 2, unknown: 1 } }),
      "2 Waiting · 1 Unknown",
    );
    assert.equal(statusBreakdown(null), "");
  });
  withLanguage("de", () => assert.equal(statusText("waiting"), "Wartet"));
});
