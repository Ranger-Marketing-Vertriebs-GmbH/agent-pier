import test from "node:test";
import assert from "node:assert/strict";
import { resolveReloadModel } from "../../server/application/session-reload-model.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const notPreserved = { message: serverMessages.sessionReload.modelNotPreservable };

const resolve = (tool, displayedModel, observedModel, options = {}) =>
  resolveReloadModel({ tool, displayedModel, observedModel, ...options });

test("Claude labels require the exact version or a dated release of that exact version", () => {
  assert.throws(() => resolve("claude", "Opus 4", "claude-opus-4-6"), notPreserved);
  assert.equal(
    resolve("claude", "Opus 4", "claude-opus-4-20250514").modelId,
    "claude-opus-4-20250514",
  );
  assert.throws(
    () => resolve("claude", "Opus 4", "claude-opus-4-20250514-extra"),
    notPreserved,
  );
  assert.equal(
    resolve("claude", "Opus 4.6", "claude-opus-4-6").modelId,
    "claude-opus-4-6",
  );
});

test("Codex effort display uses exact model and known effort values only", () => {
  for (const effort of [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ])
    for (const suffix of [effort, `${effort} effort`])
      assert.deepEqual(resolve("codex", `gpt-6 ${suffix}`, "gpt-old"), {
        modelId: "gpt-6",
        reasoningEffort: effort,
      });
  for (const suffix of ["maximum", "high unknown", "high effort extra", "high; secret"])
    assert.throws(() => resolve("codex", `gpt-6 ${suffix}`, "gpt-old"), notPreserved);
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
    notPreserved,
  );
  assert.throws(
    () => resolve("claude", "Opus 4.6 (unknown)", "claude-opus-4-6"),
    notPreserved,
  );
});

test("Codex native display capitalization preserves the canonical OpenAI model on reload", () => {
  assert.deepEqual(
    resolve("codex", "GPT-6-Astra max", "gpt-6-astra", {
      codexModels: [{ modelId: "gpt-6-astra", label: "GPT-6-Astra" }],
    }),
    {
      modelId: "gpt-6-astra",
      reasoningEffort: "max",
    },
  );
  assert.deepEqual(
    resolve("codex", "GPT-6.1-Sol", "gpt-6-astra", {
      codexModels: [{ modelId: "gpt-6.1-sol", label: "GPT-6.1-Sol" }],
    }),
    {
      modelId: "gpt-6.1-sol",
    },
  );
  assert.equal(
    resolve("codex", "Vendor/CaseSensitive", null).modelId,
    "Vendor/CaseSensitive",
  );
});

test("Codex reload resolves display labels through exact native catalog entries", () => {
  const codexModels = [
    { modelId: "probe", label: "Probe" },
    { modelId: "Vendor/CaseSensitive", label: "GPT Custom" },
    { modelId: "gpt-Provider/CaseSensitive", label: "Provider" },
  ];
  for (const [displayed, expected, effort] of [
    ["Probe", "probe", undefined],
    ["GPT Custom max", "Vendor/CaseSensitive", "max"],
    ["Provider ultra", "gpt-Provider/CaseSensitive", "ultra"],
    ["gpt-Provider/CaseSensitive", "gpt-Provider/CaseSensitive", undefined],
  ]) {
    assert.deepEqual(resolve("codex", displayed, "old-model", { codexModels }), {
      modelId: expected,
      ...(effort ? { reasoningEffort: effort } : {}),
    });
  }
  assert.equal(
    resolve("codex", null, "gpt-Provider/CaseSensitive").modelId,
    "gpt-Provider/CaseSensitive",
  );
});

test("Codex reload rejects ambiguous or unknown display labels without guessing a model", () => {
  assert.throws(
    () =>
      resolve("codex", "Shared max", "one", {
        codexModels: [
          { modelId: "one", label: "Shared" },
          { modelId: "two", label: "Shared" },
        ],
      }),
    notPreserved,
  );
  assert.throws(
    () => resolve("codex", "Unknown", "one", { codexModels: [] }),
    notPreserved,
  );
  assert.equal(
    resolve("codex", "unlisted-exact", "unlisted-exact", { codexModels: [] }).modelId,
    "unlisted-exact",
  );
});
