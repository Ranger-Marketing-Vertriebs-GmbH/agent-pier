import assert from "node:assert/strict";
import test from "node:test";
import {
  budgetForEffort,
  effortForBudget,
  maxTokensFor,
  normalizeEffort,
  normalizeEffortWithInfo,
  resolveEffort,
  resolveThinkingForMessages,
  stopFromChat,
  stopFromMessages,
  stopFromResponses,
  stopToMessages,
  stopToResponses,
  usageFromMessages,
  usageFromOpenAI,
  usageToMessages,
  usageToOpenAI,
} from "../../../server/features/protocol-adapter/mapping.js";

test("normalizeEffort keeps known values and maps Codex extras to max", () => {
  for (const value of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(normalizeEffort(value), value);
  }
  assert.equal(normalizeEffort("ultra"), "max");
  assert.equal(normalizeEffort("persistent"), "max");
  assert.equal(normalizeEffort(" HIGH "), "high");
});

test("unknown efforts map to medium and are flagged", () => {
  assert.deepEqual(normalizeEffortWithInfo("turbo"), { effort: "medium", unknown: true });
  assert.deepEqual(normalizeEffortWithInfo(7), { effort: "medium", unknown: true });
  assert.deepEqual(normalizeEffortWithInfo("low"), { effort: "low", unknown: false });
  assert.deepEqual(normalizeEffortWithInfo(undefined), {
    effort: "medium",
    unknown: false,
  });
  assert.equal(normalizeEffort("turbo"), "medium");
});

test("effort to budget table", () => {
  assert.equal(budgetForEffort("minimal"), 1024);
  assert.equal(budgetForEffort("low"), 2048);
  assert.equal(budgetForEffort("medium"), 8192);
  assert.equal(budgetForEffort("high"), 16384);
  assert.equal(budgetForEffort("xhigh"), 24576);
  assert.equal(budgetForEffort("max"), 32768);
  assert.equal(budgetForEffort("ultra"), 32768);
  assert.equal(budgetForEffort("none"), 0);
});

test("budget to nearest effort", () => {
  assert.equal(effortForBudget(1024), "minimal");
  assert.equal(effortForBudget(1500), "minimal");
  assert.equal(effortForBudget(2048), "low");
  assert.equal(effortForBudget(6000), "medium");
  assert.equal(effortForBudget(16000), "high");
  assert.equal(effortForBudget(24000), "xhigh");
  assert.equal(effortForBudget(100000), "max");
  assert.equal(effortForBudget(0), "none");
});

test("thinking is disabled when max_tokens is too small", () => {
  const r = resolveThinkingForMessages({
    thinking: { mode: "enabled", budgetTokens: 4096 },
    maxTokens: 1024,
    temperature: 0.2,
    topP: 0.9,
    toolChoice: "auto",
  });
  assert.equal(r.thinking, null);
  assert.deepEqual(r.adjustments, [
    "temperatureDropped",
    "topPDropped",
    "thinkingDisabledMaxTokens",
  ]);
});

test("Messages always drops temperature, top_p and top_k", () => {
  const r = resolveThinkingForMessages({
    thinking: null,
    maxTokens: 4000,
    temperature: 0.2,
    topP: 0.9,
    topK: 40,
    toolChoice: { name: "x" },
  });
  assert.equal(r.thinking, null);
  assert.equal(r.temperature, undefined);
  assert.equal(r.topP, undefined);
  assert.equal(r.topK, undefined);
  assert.equal("temperature" in r, false);
  assert.deepEqual(r.toolChoice, { name: "x" });
  assert.deepEqual(r.adjustments, ["temperatureDropped", "topPDropped", "topKDropped"]);
});

test("adaptive thinking relaxes forced tool choice and returns effort", () => {
  const r = resolveThinkingForMessages({
    thinking: { mode: "adaptive", effort: "high" },
    maxTokens: 32000,
    temperature: 0.2,
    topP: 0.9,
    toolChoice: { name: "x" },
  });
  assert.deepEqual(r.thinking, { type: "adaptive" });
  assert.equal(r.effort, "high");
  assert.equal(r.temperature, undefined);
  assert.equal(r.topP, undefined);
  assert.equal(r.toolChoice, "auto");
  assert.ok(r.adjustments.includes("toolChoiceRelaxed"));
});

test("enabled thinking relaxes required tool choice", () => {
  const r = resolveThinkingForMessages({
    thinking: { mode: "enabled", budgetTokens: 2048 },
    maxTokens: 8000,
    toolChoice: "required",
  });
  assert.equal(r.toolChoice, "auto");
  assert.deepEqual(r.adjustments, ["toolChoiceRelaxed"]);
});

test("forced tool choice is kept without thinking", () => {
  const r = resolveThinkingForMessages({
    thinking: { mode: "disabled" },
    maxTokens: 8000,
    toolChoice: "required",
  });
  assert.equal(r.thinking, null);
  assert.equal(r.toolChoice, "required");
  assert.deepEqual(r.adjustments, []);
});

test("display is passed through", () => {
  const adaptive = resolveThinkingForMessages({
    thinking: { mode: "adaptive", effort: "medium", display: "omitted" },
    maxTokens: 32000,
    toolChoice: "auto",
  });
  assert.deepEqual(adaptive.thinking, { type: "adaptive", display: "omitted" });
  const enabled = resolveThinkingForMessages({
    thinking: { mode: "enabled", budgetTokens: 2048, display: "summarized" },
    maxTokens: 32000,
    toolChoice: "auto",
  });
  assert.deepEqual(enabled.thinking, {
    type: "enabled",
    budget_tokens: 2048,
    display: "summarized",
  });
});

test("between_tools is passed through with its effort", () => {
  const r = resolveThinkingForMessages({
    thinking: { mode: "between_tools", effort: "low" },
    maxTokens: 32000,
    toolChoice: "auto",
  });
  assert.deepEqual(r.thinking, { type: "between_tools" });
  assert.equal(r.effort, "low");
});

test("effort minimal becomes low and none omits thinking toward Messages", () => {
  const minimal = resolveThinkingForMessages({
    thinking: { mode: "adaptive", effort: "minimal" },
    maxTokens: 32000,
    toolChoice: "auto",
  });
  assert.deepEqual(minimal.thinking, { type: "adaptive" });
  assert.equal(minimal.effort, "low");
  assert.deepEqual(minimal.adjustments, ["effortMinimalToLow"]);
  const none = resolveThinkingForMessages({
    thinking: { mode: "adaptive", effort: "none" },
    maxTokens: 32000,
    toolChoice: { name: "x" },
  });
  assert.equal(none.thinking, null);
  assert.equal(none.effort, undefined);
  assert.deepEqual(none.toolChoice, { name: "x" });
  assert.deepEqual(none.adjustments, ["thinkingOmittedEffortNone"]);
  const ultra = resolveThinkingForMessages({
    thinking: { mode: "adaptive", effort: "ultra" },
    maxTokens: 32000,
    toolChoice: "auto",
  });
  assert.equal(ultra.effort, "max");
});

test("budget is clamped below max_tokens and never below 1024", () => {
  const clamped = resolveThinkingForMessages({
    thinking: { mode: "enabled", budgetTokens: 9000 },
    maxTokens: 4000,
    toolChoice: "auto",
  });
  assert.equal(clamped.thinking.budget_tokens, 3999);
  assert.deepEqual(clamped.adjustments, ["thinkingBudgetClamped"]);
  const raised = resolveThinkingForMessages({
    thinking: { mode: "enabled", budgetTokens: 10 },
    maxTokens: 4000,
    toolChoice: "auto",
  });
  assert.equal(raised.thinking.budget_tokens, 1024);
  assert.deepEqual(raised.adjustments, ["thinkingBudgetRaised"]);
  const edge = resolveThinkingForMessages({
    thinking: { mode: "enabled", budgetTokens: 4096 },
    maxTokens: 1025,
    toolChoice: "auto",
  });
  assert.equal(edge.thinking.budget_tokens, 1024);
});

test("enabled thinking without budget uses the effort table", () => {
  const r = resolveThinkingForMessages({
    thinking: { mode: "enabled", effort: "high" },
    maxTokens: 32000,
    toolChoice: "auto",
  });
  assert.deepEqual(r.thinking, { type: "enabled", budget_tokens: 16384 });
  const none = resolveThinkingForMessages({
    thinking: { mode: "enabled", effort: "none" },
    maxTokens: 32000,
    toolChoice: "auto",
  });
  assert.equal(none.thinking, null);
});

test("adaptive thinking has no budget and is kept when max_tokens is at most 1024", () => {
  for (const mode of ["adaptive", "between_tools"]) {
    const r = resolveThinkingForMessages({
      thinking: { mode, effort: "high" },
      maxTokens: 1000,
      toolChoice: { name: "x" },
    });
    assert.deepEqual(r.thinking, { type: mode });
    assert.equal(r.effort, "high");
    assert.equal(r.toolChoice, "auto");
    assert.deepEqual(r.adjustments, ["toolChoiceRelaxed"]);
  }
});

test("maxTokensFor prefers sampling, then model output, then context share", () => {
  assert.equal(
    maxTokensFor({ sampling: { maxOutputTokens: 500 }, model: { outputTokens: 900 } }),
    500,
  );
  assert.equal(
    maxTokensFor({ sampling: { maxOutputTokens: null }, model: { outputTokens: 900 } }),
    900,
  );
  assert.equal(maxTokensFor({ sampling: {}, model: { contextTokens: 64000 } }), 16000);
  assert.equal(maxTokensFor({ sampling: {}, model: { contextTokens: 1000000 } }), 32000);
  assert.equal(maxTokensFor({}), 32000);
  const adjusted = [];
  const clamped = maxTokensFor(
    { sampling: { maxOutputTokens: 1500 }, model: { outputTokens: 900 } },
    (name) => adjusted.push(name),
  );
  assert.equal(clamped, 900);
  assert.deepEqual(adjusted, ["maxTokens.clamped"]);
});

test("usage conversion both ways", () => {
  const ir = usageFromOpenAI({ prompt: 1000, completion: 50, cached: 600 });
  assert.deepEqual(usageToMessages(ir), {
    input_tokens: 400,
    output_tokens: 50,
    cache_read_input_tokens: 600,
    cache_creation_input_tokens: 0,
  });
  const back = usageFromMessages({
    input: 400,
    output: 50,
    cacheRead: 600,
    cacheWrite: 10,
  });
  assert.deepEqual(usageToOpenAI(back), {
    input_tokens: 1010,
    output_tokens: 50,
    input_tokens_details: { cached_tokens: 600, cache_write_tokens: 10 },
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 1060,
  });
});

test("usage mappers round fractional counts and zero invalid ones", () => {
  assert.deepEqual(
    usageFromOpenAI({ prompt: 12.5, completion: 1.4, cached: 2.6, reasoning: 0.4 }),
    { input: 10, output: 1, cacheRead: 3, cacheWrite: 0, reasoning: 0, estimated: false },
  );
  assert.deepEqual(
    usageFromMessages({ input: 7.5, output: -3, cacheRead: Infinity, cacheWrite: "4" }),
    { input: 8, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimated: false },
  );
});

test("usage IR keeps reasoning and estimated flags and fills defaults", () => {
  assert.deepEqual(usageFromOpenAI({ prompt: 10, completion: 5, reasoning: 3 }), {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 3,
    estimated: false,
  });
  assert.deepEqual(usageFromMessages({ input: 4, output: 2, estimated: true }), {
    input: 4,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    estimated: true,
  });
  assert.equal(usageFromOpenAI({ prompt: 5, completion: 1, cached: 9 }).input, 0);
  assert.equal(
    usageToOpenAI(usageFromOpenAI({ prompt: 9, completion: 1, reasoning: 1 }))
      .output_tokens_details.reasoning_tokens,
    1,
  );
});

test("usage OpenAI round trip preserves totals", () => {
  const usage = usageToOpenAI(
    usageFromOpenAI({ prompt: 1000, completion: 50, cached: 600 }),
  );
  assert.equal(usage.input_tokens, 1000);
  assert.equal(usage.input_tokens_details.cached_tokens, 600);
  assert.equal(usage.total_tokens, 1050);
});

test("stop reasons from Messages upstream", () => {
  assert.equal(stopFromMessages("end_turn"), "end");
  assert.equal(stopFromMessages("max_tokens"), "length");
  assert.equal(stopFromMessages("tool_use"), "toolUse");
  assert.equal(stopFromMessages("stop_sequence"), "stopSequence");
  assert.equal(stopFromMessages("refusal"), "refusal");
  assert.equal(stopFromMessages("model_context_window_exceeded"), "length");
  assert.equal(stopFromMessages("pause_turn"), "end");
  assert.equal(stopFromMessages(null), "end");
});

test("stop reasons from Responses upstream", () => {
  assert.equal(stopFromResponses("completed", undefined, false), "end");
  assert.equal(stopFromResponses("completed", undefined, true), "toolUse");
  assert.equal(stopFromResponses("incomplete", "max_output_tokens", false), "length");
  assert.equal(stopFromResponses("incomplete", "max_output_tokens", true), "length");
  assert.equal(stopFromResponses("incomplete", "content_filter", false), "contentFilter");
  assert.equal(stopFromResponses("incomplete", "interrupted", false), "end");
});

test("stop reasons from Chat upstream", () => {
  assert.equal(stopFromChat("stop"), "end");
  assert.equal(stopFromChat("length"), "length");
  assert.equal(stopFromChat("tool_calls"), "toolUse");
  assert.equal(stopFromChat("function_call"), "toolUse");
  assert.equal(stopFromChat("content_filter"), "contentFilter");
  assert.equal(stopFromChat(null), "end");
});

test("stop reasons toward Messages clients", () => {
  assert.equal(stopToMessages("end"), "end_turn");
  assert.equal(stopToMessages("length"), "max_tokens");
  assert.equal(stopToMessages("toolUse"), "tool_use");
  assert.equal(stopToMessages("stopSequence"), "stop_sequence");
  assert.equal(stopToMessages("contentFilter"), "refusal");
  assert.equal(stopToMessages("refusal"), "refusal");
});

test("length toward Responses clients is completed", () => {
  assert.deepEqual(stopToResponses("length"), { status: "completed" });
});

test("stop reasons toward Responses clients never use incomplete", () => {
  assert.deepEqual(stopToResponses("end"), { status: "completed" });
  assert.deepEqual(stopToResponses("toolUse"), { status: "completed" });
  assert.deepEqual(stopToResponses("stopSequence"), { status: "completed" });
  assert.deepEqual(stopToResponses("contentFilter"), {
    status: "failed",
    errorCode: "invalid_prompt",
  });
  assert.deepEqual(stopToResponses("refusal"), {
    status: "completed",
    refusalAsText: true,
  });
});

test("stop mapping is total", () => {
  const reasons = [
    "end",
    "length",
    "toolUse",
    "stopSequence",
    "contentFilter",
    "refusal",
  ];
  for (const reason of reasons) {
    assert.equal(typeof stopToMessages(reason), "string");
    assert.notEqual(stopToResponses(reason).status, "incomplete");
  }
  assert.throws(() => stopToMessages("bogus"), TypeError);
  assert.throws(() => stopToResponses("bogus"), TypeError);
});

test("unknown effort becomes medium and is reported as effortUnknown", () => {
  const seen = [];
  assert.equal(
    resolveEffort("turbo", (name) => seen.push(name)),
    "medium",
  );
  assert.equal(
    resolveEffort("high", (name) => seen.push(name)),
    "high",
  );
  assert.equal(
    resolveEffort(undefined, (name) => seen.push(name)),
    "medium",
  );
  assert.deepEqual(seen, ["effortUnknown"]);
  const adaptive = resolveThinkingForMessages({
    thinking: { mode: "adaptive", effort: "turbo" },
    maxTokens: 32000,
    toolChoice: "auto",
  });
  assert.equal(adaptive.effort, "medium");
  assert.deepEqual(adaptive.adjustments, ["effortUnknown"]);
  const enabled = resolveThinkingForMessages({
    thinking: { mode: "enabled", effort: "turbo" },
    maxTokens: 32000,
    toolChoice: "auto",
  });
  assert.deepEqual(enabled.thinking, { type: "enabled", budget_tokens: 8192 });
  assert.deepEqual(enabled.adjustments, ["effortUnknown"]);
});

test("maxTokensFor never returns 0 and clamps explicit values to the model limit", () => {
  assert.equal(maxTokensFor({ sampling: {}, model: { contextTokens: 3 } }), 1);
  assert.equal(maxTokensFor({ sampling: {}, model: { contextTokens: 0 } }), 1);
  const adjusted = [];
  const value = maxTokensFor(
    { sampling: { maxOutputTokens: 64000 }, model: { outputTokens: 8192 } },
    (name) => adjusted.push(name),
  );
  assert.equal(value, 8192);
  assert.deepEqual(adjusted, ["maxTokens.clamped"]);
});
