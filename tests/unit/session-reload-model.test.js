import test from "node:test";
import assert from "node:assert/strict";
import { resolveReloadModel } from "../../server/application/session-reload-model.js";

const resolve = (tool, displayedModel, observedModel) =>
  resolveReloadModel({ tool, displayedModel, observedModel });

test("Claude labels require the exact version or a dated release of that exact version", () => {
  assert.throws(() => resolve("claude", "Opus 4", "claude-opus-4-6"), /preserved/);
  assert.equal(
    resolve("claude", "Opus 4", "claude-opus-4-20250514").modelId,
    "claude-opus-4-20250514",
  );
  assert.throws(
    () => resolve("claude", "Opus 4", "claude-opus-4-20250514-extra"),
    /preserved/,
  );
  assert.equal(
    resolve("claude", "Opus 4.6", "claude-opus-4-6").modelId,
    "claude-opus-4-6",
  );
});

test("Codex effort display uses exact model and known effort values only", () => {
  for (const effort of ["minimal", "low", "medium", "high", "xhigh"])
    for (const suffix of [effort, `${effort} effort`])
      assert.deepEqual(resolve("codex", `gpt-6 ${suffix}`, "gpt-old"), {
        modelId: "gpt-6",
        reasoningEffort: effort,
      });
  for (const suffix of ["maximum", "high unknown", "high effort extra", "high; secret"])
    assert.throws(() => resolve("codex", `gpt-6 ${suffix}`, "gpt-old"), /preserved/);
});

test("Claude known display decorators retain independently observed extended context", () => {
  assert.equal(
    resolve("claude", "Opus 4.6 (1M context) (default)", "claude-opus-4-6[1m]").modelId,
    "claude-opus-4-6[1m]",
  );
  assert.equal(
    resolve("claude", "Opus 4.6 (default)", "claude-opus-4-6").modelId,
    "claude-opus-4-6",
  );
  assert.throws(
    () => resolve("claude", "Opus 4.6 (1M context)", "claude-opus-4-6"),
    /preserved/,
  );
  assert.throws(
    () => resolve("claude", "Opus 4.6 (unknown)", "claude-opus-4-6"),
    /preserved/,
  );
});
