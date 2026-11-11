import test from "node:test";
import assert from "node:assert/strict";
import {
  currentModel,
  modelPromptReady,
  parseModelPicker,
} from "../../server/features/models/model-controller.js";
import { resolveReloadModel } from "../../server/application/session-reload-model.js";
import { parseSessionActivity } from "../../server/features/sessions/session-activity.js";
import { nativeLimitWarnings } from "../../server/features/chat/native-limit-warnings.js";

// A family Claude Code may name one day; nothing in AgentPier knows it.
const resolve = (displayedModel, observedModel, options = {}) =>
  resolveReloadModel({ tool: "claude", displayedModel, observedModel, ...options });
const header = (model, plan = "Claude Max") =>
  ` ▐▛███▛█   Claude Code v2.1.322\n▝▜██████▀  ${model} · ${plan}\n ▝▝   ▝▝   /fixture`;

test("a new Claude family is read from the header and the /model receipt", () => {
  for (const [model, plan] of [
    ["Mythos 6.1", "Claude Max"],
    ["Mythos 6.1 (1M context)", "API Usage Billing"],
    ["Mythos 6", "Claude Team"],
  ])
    assert.equal(currentModel("claude", header(model, plan)), model);
  // A narrow pane wraps the plan onto the next row.
  assert.equal(
    currentModel("claude", "▝▜██████▀  Mythos 6.1 (1M context) ·\n Claude Max"),
    "Mythos 6.1 (1M context)",
  );
  assert.equal(
    currentModel("claude", header("Mythos 6.1 with high effort")),
    "Mythos 6.1",
  );
  for (const [receipt, model] of [
    ["Set model to Mythos 6.1 and saved as your default for new sessions", "Mythos 6.1"],
    [
      "Set model to Mythos 6.1 (1M context) for this session only",
      "Mythos 6.1 (1M context)",
    ],
  ])
    assert.equal(currentModel("claude", `❯ /model x\n  ⎿  ${receipt}\n❯ `), model);
});

test("header text that names no model is not read as one", () => {
  for (const screen of [
    " ▐▛███▛█   Claude Code v2.1.322\n ▝▝   ▝▝   /fixture",
    // No version, a lower-case word, a word glued to other text.
    "▝▜██████▀  Organization · Claude Max",
    "▝▜██████▀  plan 2 · Claude Max",
    "▝▜██████▀  v2.1 · API Usage Billing",
    // Running text, not the header row.
    "See Chapter 3 · Claude explains it there",
    "Welcome back Dana · Claude Max",
    "Tokens 12 used · API",
  ])
    assert.equal(currentModel("claude", screen), null, screen);
});

test("a new Claude family reloads with the id its name gives", () => {
  assert.deepEqual(resolve("Mythos 6.1", undefined), { modelId: "claude-mythos-6-1" });
  assert.deepEqual(resolve("Mythos 6.1 (1M context)", "claude-fable-5-2"), {
    modelId: "claude-mythos-6-1[1m]",
  });
  assert.deepEqual(resolve("Mythos 6.1 (default)", "claude-mythos-6-1-20270101"), {
    modelId: "claude-mythos-6-1-20270101",
  });
  // No minor version, or a generation before 4: no id rule, so the launch model.
  for (const label of ["Mythos 6", "Mythos 3.5", "Mythos Preview", "mythos 6.1"]) {
    const result = resolve(label, undefined, { fallbackModel: "claude-fable-5-2" });
    assert.deepEqual(result, { modelId: "claude-fable-5-2", unresolved: label }, label);
  }
});

// The picker of Claude Code 2.1.322: the current row names the family alone and
// starts its description with the model.
const picker = (family, model) =>
  [
    "❯ /model",
    "─".repeat(100),
    "  Select model",
    "  Switch between Claude models. Your pick becomes the default for new sessions.",
    "",
    "    1. Default (recommended)  Use the default model (currently Opus 5.5) · $4/$20 per Mtok",
    "    2. Opus                   Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok",
    `  ❯ 3. ${family} ✔${" ".repeat(18 - family.length)}${model} · Most capable · $8/$40 per Mtok`,
    "    4. Haiku                  Haiku 5.5 · Fastest for quick answers · $0.10/$0.50 per Mtok",
    "",
    "  ◐ Medium effort (default) ←/→ to adjust",
    "",
    "  Enter to set as default · s to use this session only · Esc to cancel",
  ].join("\n");

test("the picker names the current model of any family, with its version", () => {
  for (const [family, model] of [
    ["Mythos", "Mythos 6.1"],
    ["Mythos", "Mythos 6.1 (1M context)"],
    ["Sonnet", "Sonnet 5.5"],
  ]) {
    const menu = parseModelPicker("claude", picker(family, model));
    assert.ok(menu, "the picker is read");
    assert.equal(menu.currentModel, model);
    assert.equal(menu.options[2].label, family);
  }
  assert.deepEqual(
    resolve(parseModelPicker("claude", picker("Mythos", "Mythos 6.1")).currentModel),
    { modelId: "claude-mythos-6-1" },
  );
});

test("a footer that shows only a model of any family is a ready prompt", () => {
  const screen = (footer) => `Claude Code\n❯ \n  ${footer}`;
  for (const footer of ["Mythos 6.1 · Claude Max", "Fable 5.2 · Claude Max", "Opus 5"])
    assert.equal(modelPromptReady("claude", screen(footer)), true, footer);
  for (const footer of ["some other text", "step 2 of 3", "Chapter"])
    assert.equal(modelPromptReady("claude", screen(footer)), false, footer);
  const ruled = (footer) => `\n\n${"─".repeat(24)}\n❯ \n${"─".repeat(24)}\n  ${footer}`;
  assert.equal(
    parseSessionActivity("claude", ruled("Mythos 6.1 · Claude")).state,
    "idle",
  );
  assert.equal(parseSessionActivity("claude", ruled("some other text")).state, "unknown");
});

test("a limit warning names any model family", () => {
  const border = "─".repeat(100);
  const read = (text) =>
    nativeLimitWarnings(
      "claude",
      [border, "❯ ", border, "  ? for shortcuts", "  " + text, ""].join("\n"),
      { width: 100, height: 7, cursorX: 2, cursorY: 1 },
    );
  for (const text of [
    "Approaching Mythos limit",
    "You've used 90% of your Mythos limit · resets Oct 4 at 12pm",
    "Approaching Opus limit",
  ])
    assert.deepEqual(read(text), [text]);
  // Not a family name: lower case, two words, or no warning at all.
  for (const text of [
    "Approaching some limit",
    "Approaching The Speed limit",
    "Mythos limit",
    "You've used 5% of your Mythos limit",
  ])
    assert.deepEqual(read(text), [], text);
});
