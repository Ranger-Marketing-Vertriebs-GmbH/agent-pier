import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  parseModelPicker,
  modelPromptReady,
  ModelController,
} from "../../server/features/models/model-controller.js";
import { unsupportedModelPicker } from "../../server/features/models/model-parser.js";

// Claude Code 2.1.329 redrew /model: a "Your pick is the default …" subtitle, a
// session-only footer that starts with "s", an effort row and, for subscriptions,
// a "More models" expander whose models are hidden until it is opened.
const fixture = async (name) =>
  fs.readFile(new URL(`../fixtures/models/${name}`, import.meta.url), "utf8");

const sessionFooter = "s to use this session only · Enter to save · Esc to cancel";
/** The open expander as Claude draws it while a model, not the expander, has focus. */
const modelFocused = (screen) =>
  screen
    .replace("\n\n  Use /fast", "\n\n  ◐ Medium effort (default)\n\n  Use /fast")
    .replace("Enter to collapse · Esc to cancel", sessionFooter);

/** Moves the native focus marker to the row numbered `n`, or to "More models". */
function focus(screen, n) {
  return screen
    .split("\n")
    .map((line) => {
      const row = /^  (?:❯| ) (\d+\.|[▸▾] More models)(.*)$/.exec(line);
      if (!row) return line;
      const target = n === "more" ? /More models/.test(row[1]) : row[1] === `${n}.`;
      return `  ${target ? "❯" : " "} ${row[1]}${row[2]}`;
    })
    .join("\n");
}

test("Claude 2.1.329's captured /model screen lists its models, not the effort row", async () => {
  const raw = await fixture("claude-2.1.329-model.ansi");
  const menu = parseModelPicker("claude", raw);
  assert.ok(menu, "the redrawn picker must be recognised");
  assert.deepEqual(
    menu.options.map((option) => option.label),
    ["Default (recommended)", "Opus", "Fable", "Sonnet", "Haiku"],
  );
  assert.equal(menu.selected, "0");
  assert.equal(menu.currentModel, "Opus 5.5");
  assert.equal(menu.selectKey, "s", "a pick in chat must not become the default");
  assert.match(menu.options[4].description, /over 100k\)$/);
  assert.equal(modelPromptReady("claude", raw), false);
  assert.equal(unsupportedModelPicker("claude", raw), false);
});

test("Claude 2.1.329's picker reads at 50 columns with its footer wrapped", async () => {
  const raw = await fixture("claude-2.1.329-model-50.txt");
  const menu = parseModelPicker("claude", raw);
  assert.ok(menu);
  assert.equal(menu.options.length, 5);
  assert.equal(menu.currentModel, "Opus 5.5");
  assert.equal(menu.selectKey, "s");
  assert.equal(menu.options[0].description, "Use the default model (currently Opus 5.5)");
});

test("a picker that would only save the default stays undriven", async () => {
  const raw = (await fixture("claude-2.1.329-model.ansi")).replace(
    "s to use this session only · ",
    "",
  );
  assert.equal(parseModelPicker("claude", raw), null);
  assert.equal(unsupportedModelPicker("claude", raw), true);
  assert.equal(modelPromptReady("claude", raw), false);
});

test("the More models expander is a navigation stop, not a model", async () => {
  const collapsed = parseModelPicker(
    "claude",
    await fixture("claude-2.1.329-more-collapsed.txt"),
  );
  assert.equal(collapsed.options.length, 5);
  assert.equal(collapsed.currentModel, "Opus 5.5");
  assert.equal(collapsed.selected, "1");
  const expanded = parseModelPicker(
    "claude",
    focus(modelFocused(await fixture("claude-2.1.329-more-expanded.txt")), 2),
  );
  assert.deepEqual(
    expanded.options.map((option) => [option.label, option.position]),
    [
      ["Default (recommended)", 0],
      ["Opus 5.5", 1],
      ["Fable 5.2", 2],
      ["Sonnet 5.5", 3],
      ["Haiku 5.5", 4],
      ["Opus 4.7", 6],
      ["Sonnet 4.6", 7],
      ["Haiku 4.5", 8],
    ],
  );
  // Focus on the expander itself selects no model: input stays blocked.
  const onExpander = await fixture("claude-2.1.329-more-focused.txt");
  assert.equal(parseModelPicker("claude", onExpander), null);
  assert.equal(modelPromptReady("claude", onExpander), false);
  // Its footer offers no session-only pick, whatever row the screen marks.
  assert.equal(parseModelPicker("claude", focus(onExpander, 2)), null);
});

function fakeClaude(screens) {
  const calls = [];
  const state = { screen: screens.idle };
  const sessions = {
    control: async (id, fn) =>
      fn({
        session: { id, tool: "claude", status: "running" },
        screen: async () => state.screen,
        keys: async (keys) => {
          calls.push(keys);
          state.screen = screens.next(state.screen, keys) ?? state.screen;
        },
        type: async (value) => calls.push(["text", value]),
      }),
  };
  return { sessions, state, calls };
}

test("opening Claude's picker in chat expands More models and selects one of them", async () => {
  const collapsed = await fixture("claude-2.1.329-more-collapsed.txt");
  const expanded = await fixture("claude-2.1.329-more-expanded.txt");
  const idle =
    " ▐▛███▛█   Claude Code v2.1.329\n▝▜██████▀  Opus 5.5 · Claude Max\n" +
    "────\n❯ \n────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents";
  let row = 2;
  let open = false;
  const { sessions, calls } = fakeClaude({
    idle,
    next(screen, keys) {
      const key = keys[0];
      if (key === "M-p") return collapsed;
      const positions = open ? [1, 2, 3, 4, 5, "more", 6, 7, 8] : [1, 2, 3, 4, 5, "more"];
      if (key === "Down" || key === "Up") {
        let at = positions.indexOf(row);
        at += (key === "Down" ? 1 : -1) * keys.length;
        row = positions[at];
      }
      if (key === "Enter" && row === "more") open = true;
      if (key === "s") return idle.replace("Opus 5.5 ·", "Sonnet 4.6 ·");
      // Focus on the expander hides the effort row and names its action.
      const base = open
        ? row === "more"
          ? expanded
          : modelFocused(expanded)
        : row === "more"
          ? collapsed
              .replace("  ◐ Medium effort (default)\n\n", "")
              .replace(sessionFooter, "Enter to expand · Esc to cancel")
          : collapsed;
      return focus(base, row);
    },
  });
  const models = new ModelController({ sessions, timeout: 400 });
  const opened = await models.open("one");
  assert.ok(opened.picker, opened.notice);
  assert.deepEqual(
    opened.picker.options.map((option) => option.label),
    [
      "Default (recommended)",
      "Opus 5.5",
      "Fable 5.2",
      "Sonnet 5.5",
      "Haiku 5.5",
      "Opus 4.7",
      "Sonnet 4.6",
      "Haiku 4.5",
    ],
  );
  assert.equal(opened.picker.selected, "1", "focus returns to the current model");
  assert.deepEqual(calls, [
    ["M-p"],
    ["Down", "Down", "Down", "Down"],
    ["Enter"],
    ["Up", "Up", "Up", "Up"],
  ]);
  const selected = await models.select("one", {
    token: opened.picker.token,
    optionId: "6",
  });
  assert.equal(selected.currentModel, "Sonnet 4.6");
  assert.equal(selected.picker, null);
  assert.deepEqual(calls.slice(4), [Array(6).fill("Down"), ["s"]]);
});

test("expansion never presses Enter unless the expander has the focus", async () => {
  const collapsed = await fixture("claude-2.1.329-more-collapsed.txt");
  const { sessions, calls } = fakeClaude({
    idle: "Claude Code\nOpus 5.5 · Claude Max\n❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)",
    // The terminal ignores the arrows: focus stays on the current model.
    next: (screen, keys) => (keys[0] === "M-p" ? collapsed : screen),
  });
  const models = new ModelController({ sessions, timeout: 200 });
  const opened = await models.open("one");
  assert.equal(opened.picker.options.length, 5);
  assert.deepEqual(calls, [["M-p"], ["Down", "Down", "Down", "Down"]]);
});
