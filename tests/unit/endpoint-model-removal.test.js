import test from "node:test";
import assert from "node:assert/strict";
import { withoutModels } from "../../web/features/provider-connections/endpoint-draft.js";

const model = (modelId, source) => ({ modelId, label: modelId, source });

test("removing detected models keeps the manual ones and drops the stale cap note", () => {
  const draft = {
    models: [model("a", "detected"), model("b", "manual"), model("c", "detected")],
    modelsTruncated: true,
  };
  const next = withoutModels(draft, (item) => item.source === "detected");
  assert.deepEqual(
    next.models.map((item) => item.modelId),
    ["b"],
  );
  assert.equal(next.modelsTruncated, false);
  assert.equal(draft.models.length, 3, "the draft itself is unchanged");
});
