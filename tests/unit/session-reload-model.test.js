import test from "node:test";
import assert from "node:assert/strict";
import { resolveReloadModel } from "../../server/application/session-reload-model.js";

const resolve = (tool, displayedModel, observedModel, options = {}) =>
  resolveReloadModel({ tool, displayedModel, observedModel, ...options });
/** The name could not be mapped: the launch model (or none) is used and reported. */
const unresolved = (tool, displayedModel, observedModel, options = {}) => {
  const result = resolve(tool, displayedModel, observedModel, options);
  assert.equal(result.unresolved, displayedModel);
  assert.equal(result.modelId, options.fallbackModel);
  assert.equal(result.reasoningEffort, undefined);
};

test("Claude labels without a minor version need the exact version or a dated release of it", () => {
  unresolved("claude", "Opus 4", "claude-opus-4-6");
  unresolved("claude", "Opus 4", "claude-opus-4-6", { fallbackModel: "claude-opus-4-6" });
  assert.equal(
    resolve("claude", "Opus 4", "claude-opus-4-20250514").modelId,
    "claude-opus-4-20250514",
  );
  unresolved("claude", "Opus 4", "claude-opus-4-20250514-extra");
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
    unresolved("codex", `gpt-6 ${suffix}`, "gpt-old", { fallbackModel: "gpt-launch" });
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
  // The label is what the CLI runs now; the last response's model may be older.
  assert.equal(
    resolve("claude", "Opus 4.6 (1M context)", "claude-opus-4-6").modelId,
    "claude-opus-4-6[1m]",
  );
  unresolved("claude", "Opus 4.6 (unknown)", "claude-opus-4-6");
});

test("Claude Code 2.1.322 names every current family, and each is kept on reload", () => {
  for (const [label, id] of [
    ["Fable 5.2", "claude-fable-5-2"],
    ["Opus 5.5", "claude-opus-5-5"],
    ["Sonnet 5.5", "claude-sonnet-5-5"],
    ["Haiku 5.5", "claude-haiku-5-5"],
  ]) {
    // Confirmed by the last response, right after a switch (the last response still
    // names the model before it), and before any response.
    assert.deepEqual(resolve("claude", label, id), { modelId: id });
    assert.deepEqual(resolve("claude", label, "claude-opus-4-6"), { modelId: id });
    assert.deepEqual(resolve("claude", label, undefined), { modelId: id });
    assert.deepEqual(resolve("claude", `${label} (default)`, undefined), { modelId: id });
  }
});

test("a Claude label keeps the exact id the session was launched with", () => {
  assert.deepEqual(
    resolve("claude", "Sonnet 5.5", "claude-fable-5-2", {
      fallbackModel: "claude-sonnet-5-5[1m]",
    }),
    { modelId: "claude-sonnet-5-5[1m]" },
  );
  assert.deepEqual(
    resolve("claude", "Sonnet 5.5", undefined, {
      fallbackModel: "claude-sonnet-5-5-20261001",
    }),
    { modelId: "claude-sonnet-5-5-20261001" },
  );
});

test("a name that cannot be mapped keeps the launch model and is reported", () => {
  unresolved("claude", "Mythos Preview", "claude-fable-5-2", {
    fallbackModel: "claude-fable-5-2",
  });
  unresolved("claude", "Sonnet 3.7", "claude-3-7-sonnet-20250219");
  unresolved("claude", "Mythos Preview", undefined);
  // Not a valid id: the CLI's default is used.
  assert.equal(
    resolve("claude", "Mythos Preview", undefined, { fallbackModel: "not an id" })
      .modelId,
    undefined,
  );
});

test("Codex native display capitalization preserves the canonical OpenAI model on reload", () => {
  assert.deepEqual(
    resolve("codex", "GPT-6-Astra max", "gpt-6-astra", {
      models: [{ modelId: "gpt-6-astra", label: "GPT-6-Astra" }],
    }),
    {
      modelId: "gpt-6-astra",
      reasoningEffort: "max",
    },
  );
  assert.deepEqual(
    resolve("codex", "GPT-6.1-Sol", "gpt-6-astra", {
      models: [{ modelId: "gpt-6.1-sol", label: "GPT-6.1-Sol" }],
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
  const models = [
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
    assert.deepEqual(resolve("codex", displayed, "old-model", { models }), {
      modelId: expected,
      ...(effort ? { reasoningEffort: effort } : {}),
    });
  }
  assert.equal(
    resolve("codex", null, "gpt-Provider/CaseSensitive").modelId,
    "gpt-Provider/CaseSensitive",
  );
});

test("Codex reload does not guess a model for an ambiguous or unknown display label", () => {
  unresolved("codex", "Shared max", "one", {
    models: [
      { modelId: "one", label: "Shared" },
      { modelId: "two", label: "Shared" },
    ],
  });
  unresolved("codex", "Unknown", "one", { models: [], fallbackModel: "one" });
  assert.equal(
    resolve("codex", "unlisted-exact", "unlisted-exact", { models: [] }).modelId,
    "unlisted-exact",
  );
});

test("a tool without a picker resolver keeps an exact displayed id only", () => {
  for (const tool of ["shell", "opencode"]) {
    assert.deepEqual(resolve(tool, "anthropic/claude-6", "other"), {
      modelId: "anthropic/claude-6",
    });
    unresolved(tool, "Opus 4.6", "claude-opus-4-6");
  }
  assert.deepEqual(resolve("shell", undefined, "observed-id"), {
    modelId: "observed-id",
  });
});
