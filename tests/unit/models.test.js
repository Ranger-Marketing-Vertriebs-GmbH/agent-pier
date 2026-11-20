import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  parseModelPicker,
  currentModel,
  modelPromptReady,
  ModelController,
} from "../../server/features/models/model-controller.js";
const fixture = async (name) =>
  fs.readFile(new URL(`../fixtures/models/${name}`, import.meta.url), "utf8");
const CLAUDE_MENU = "claude-2.1.329-model.ansi";
const menuFixture = (tool) =>
  fixture(tool === "claude" ? CLAUDE_MENU : `${tool}-model.ansi`);
test("Codex 0.160 pickers with short key-hint footers are recognized", async () => {
  const select = parseModelPicker("codex", await fixture("codex-0160-model-select.ansi"));
  assert.equal(select?.kind, "model");
  assert.equal(select.selected, "0");
  assert.equal(select.currentModel, "Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M");
  assert.equal(select.selectKey, "Enter");
  const single = parseModelPicker(
    "codex",
    await fixture("codex-0160-model-session.ansi"),
  );
  assert.equal(single?.kind, "model");
  assert.equal(single.options.length, 1);
  assert.equal(single.selectKey, "Enter");
  const effort = parseModelPicker("codex", await fixture("codex-0160-effort.ansi"));
  assert.equal(effort?.kind, "effort");
  assert.deepEqual(
    effort.options.map((o) => o.label),
    ["Low", "Medium (default)", "High"],
  );
  assert.equal(effort.selected, "1");
  assert.equal(effort.selectKey, "Enter");
  const quoted = await fixture("codex-0160-effort.ansi");
  assert.equal(
    parseModelPicker("codex", quoted.trimEnd() + "\n› Ask Codex\n  model medium"),
    null,
  );
  assert.equal(
    parseModelPicker(
      "codex",
      "Approve command?\n› 1. Yes\n  2. No\nPress enter to confirm",
    ),
    null,
  );
});
test("Codex 0.160 composer with a shortcut hint below the model line is ready", async () => {
  for (const name of ["codex-0160-composer.ansi", "codex-0160-composer-agents.ansi"]) {
    const raw = await fixture(name);
    assert.equal(
      currentModel("codex", raw),
      "Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M medium",
    );
    assert.equal(modelPromptReady("codex", raw), true);
    const draft = raw.replace(/Ask Codex to do anything/, "\x1b[0mreal draft");
    assert.equal(modelPromptReady("codex", draft), false);
  }
});
test("OpenCode parses ANSI highlighted model and omits provider-auth choices", async () => {
  const menu = parseModelPicker("opencode", await fixture("opencode-model.ansi"));
  assert.equal(menu.searchable, true);
  assert.equal(menu.options.length, 6);
  assert.equal(menu.options.find((x) => x.current).label, "Big Pickle");
  assert.equal(menu.selected, "5");
  assert.equal(menu.currentModel, "Big Pickle");
  assert.ok(menu.options.every((x) => !x.label.includes("OpenAI")));
});
test("Codex model readiness refuses drafts and disabled input but allows a running task", () => {
  assert.equal(
    modelPromptReady(
      "codex",
      "OpenAI Codex\n› \x1b[2mExplain this codebase\x1b[0m\n  ? for shortcuts",
    ),
    true,
  );
  for (const screen of [
    "OpenAI Codex\n› delete everything\n? for shortcuts",
    "OpenAI Codex\n› \x1b[2mInput disabled.\x1b[0m\n? for shortcuts",
  ])
    assert.equal(modelPromptReady("codex", screen), false);
});
test("Claude Code 2.1.322's header and /model receipt name the model alone", () => {
  const header =
    " ▐▛███▛█   Claude Code v2.1.322\n▝▜██████▀  Fable 5.2 · Claude Max\n ▝▝   ▝▝   /fixture";
  assert.equal(currentModel("claude", header), "Fable 5.2");
  assert.equal(
    currentModel(
      "claude",
      header.replace("Fable 5.2 · Claude Max", "Haiku 5.5 · API Usage Billing"),
    ),
    "Haiku 5.5",
  );
  // The header has scrolled away: the last receipt is read.
  for (const [receipt, model] of [
    ["Set model to Sonnet 5.5 and saved as your default for new sessions", "Sonnet 5.5"],
    ["Set model to Fable 5.2 and saved as your default for new sessions", "Fable 5.2"],
    ["Set model to Sonnet 5.5 for this session only", "Sonnet 5.5"],
    ["Set model to Opus 5.5 with high effort", "Opus 5.5"],
  ])
    assert.equal(currentModel("claude", `❯ /model x\n  ⎿  ${receipt}\n❯ `), model);
});
test("Claude live header takes precedence over old receipts after shortcut switching", () => {
  assert.equal(
    currentModel(
      "claude",
      "Opus 5 · API Usage Billing\n  ⎿ Set model to Sonnet 5 for this session only",
    ),
    "Opus 5",
  );
  assert.equal(
    currentModel("opencode", "┃ Build · Big Pickle OpenCode Zen"),
    "Big Pickle OpenCode Zen",
  );
  // A thought's duration in the transcript is not the model (AGENTPIER-426).
  assert.equal(
    currentModel("opencode", "  ┃  Thought · 141ms\n\n  ┃ Build · gpt-6.2-sol Azure\n"),
    "gpt-6.2-sol Azure",
  );
  assert.equal(currentModel("opencode", "  ┃  Thought · 1.2s\n"), null);
  assert.equal(
    currentModel("codex", "Switched to Plan mode\nSwitched to branch main"),
    null,
  );
});
test("OpenCode provider headers never become options or selected model", () => {
  const raw =
    "\x1b[48;5;233m    Select model                    esc\n\n    Search\n\n    \x1b[1mAnthropic\x1b[22m\n    Claude Sonnet\n    \x1b[1mOpenAI\x1b[22m\n  \x1b[48;5;216m● \x1b[1mGPT 5\x1b[22m\x1b[48;5;233m\n    \x1b[1mOpenRouter\x1b[22m\n    GPT 5\n\n    Connect provider ctrl+a\n\x1b[0m";
  const menu = parseModelPicker("opencode", raw);
  assert.deepEqual(
    menu.options.map((x) => x.label),
    ["Claude Sonnet", "GPT 5", "GPT 5"],
  );
  assert.equal(menu.selected, "1");
  assert.match(menu.options[1].description, /OpenAI/);
  assert.match(menu.options[2].description, /OpenRouter/);
});
test("OpenCode empty results remain searchable and keep underlying prompt blocked", () => {
  const raw =
    "┃ Build · Big Pickle OpenCode Zen\n\x1b[48;5;233m    Select model                    esc\n\n    no-match\n\n    No results found\n\n    Connect provider ctrl+a\x1b[0m\nctrl+p commands";
  const menu = parseModelPicker("opencode", raw);
  assert.ok(menu);
  assert.equal(menu.searchable, true);
  assert.deepEqual(menu.options, []);
  assert.equal(menu.selected, null);
  assert.equal(menu.searchQuery, "no-match");
  assert.equal(modelPromptReady("opencode", raw), false);
  assert.equal(
    modelPromptReady(
      "opencode",
      "┃ Build · Big Pickle OpenCode Zen\n    Connect a provider        esc\nctrl+p commands",
    ),
    false,
  );
  assert.equal(
    modelPromptReady(
      "opencode",
      "┃ Build · Big Pickle OpenCode Zen\nNative text  Connect a provider        esc  underlying text\nctrl+p commands",
    ),
    false,
  );
});
function fakeManager(tool, screen) {
  const calls = [];
  const state = { screen };
  const sessions = {
    control: async (id, fn) =>
      fn({
        session: { id, tool, status: "running" },
        screen: async () => state.screen,
        keys: async (keys) => {
          calls.push(keys);
          state.onKeys?.(keys);
        },
        type: async (value) => calls.push(["text", value]),
      }),
  };
  return { sessions, state, calls };
}
test("a narrow Claude picker opens, switches and cancels through chat without changing the default", async () => {
  const menu = await fixture("claude-2.1.329-model-50.txt");
  const idle = "Claude Code\nOpus 5.5 · API Usage Billing\n❯ draft\n? for shortcuts";
  const { sessions, state, calls } = fakeManager("claude", idle);
  state.onKeys = (keys) => {
    if (keys.join() === "M-p") state.screen = menu;
    if (keys.join() === "Down,Down,Down,Down")
      state.screen = menu
        .replace("    5. Haiku", "  ❯ 5. Haiku")
        .replace("  ❯ 1.", "    1.");
    if (keys.join() === "s") state.screen = idle.replace("Opus 5.5", "Haiku 5.5");
    if (keys.join() === "Escape") state.screen = idle;
  };
  const models = new ModelController({ sessions, timeout: 300 });
  const opened = await models.open("one");
  assert.ok(opened.picker);
  assert.throws(() => models.guardInput("one", { tool: "claude" }, state.screen), {
    status: 409,
  });
  const selected = await models.select("one", {
    token: opened.picker.token,
    optionId: "4",
  });
  assert.equal(selected.currentModel, "Haiku 5.5");
  assert.equal(selected.pending, false);
  assert.equal(selected.picker, null);
  assert.doesNotThrow(() => models.guardInput("one", { tool: "claude" }, state.screen));
  const reopened = await models.open("one");
  const cancelled = await models.cancel("one", { token: reopened.picker.token });
  assert.equal(cancelled.pending, false);
  assert.deepEqual(calls, [
    ["M-p"],
    ["Down", "Down", "Down", "Down"],
    ["s"],
    ["M-p"],
    ["Escape"],
  ]);
});
test("Claude selection refuses default-only confirmation and keeps input blocked", async () => {
  const raw = (await fixture(CLAUDE_MENU)).replace("s to use this session only · ", "");
  assert.equal(parseModelPicker("claude", raw), null);
  assert.equal(modelPromptReady("claude", raw), false);
  const { sessions, calls } = fakeManager("claude", raw);
  const models = new ModelController({ sessions });
  assert.equal((await models.read("one")).pending, true);
  assert.throws(
    () => new ModelController({ sessions }).guardInput("one", { tool: "claude" }, raw),
    { status: 409 },
  );
  await assert.rejects(models.open("one"), { status: 409 });
  assert.deepEqual(calls, []);
});
test("Claude confirmation follows the current footer and rejects tokens from another action", async () => {
  const raw = await fixture(CLAUDE_MENU);
  const confirm = raw.replace(
    "s to use this session only · Enter to save",
    "Enter to confirm",
  );
  const { sessions, state, calls } = fakeManager("claude", raw);
  const models = new ModelController({ sessions, timeout: 100 });
  const opened = await models.read("one");
  state.screen = "An old menu said: s to use this session only\n" + confirm;
  const current = await models.read("one");
  assert.equal(parseModelPicker("claude", state.screen).selectKey, "Enter");
  await assert.rejects(
    models.select("one", { token: opened.picker.token, optionId: "0" }),
    { status: 409 },
  );
  assert.deepEqual(calls, []);
  state.onKeys = () => {
    state.screen = "Claude Code\n❯\n? for shortcuts";
  };
  const selected = await models.select("one", {
    token: current.picker.token,
    optionId: "0",
  });
  assert.equal(selected.pending, false);
  assert.deepEqual(calls, [["Enter"]]);
});
test("stale menu tokens cannot send keys to another native screen", async () => {
  const { sessions, state, calls } = fakeManager("claude", await fixture(CLAUDE_MENU));
  const models = new ModelController({ sessions });
  const initial = await models.read("one");
  state.screen = "Do you approve this command?";
  await assert.rejects(
    models.select("one", { token: initial.picker.token, optionId: "1" }),
    /geändert|erneut/,
  );
  assert.deepEqual(calls, []);
});
test("selection is acknowledged by native state and never confirms an unexpected dialog", async () => {
  const { sessions, state, calls } = fakeManager("claude", await fixture(CLAUDE_MENU));
  const models = new ModelController({ sessions, timeout: 100 });
  const initial = await models.read("one");
  state.onKeys = () => {
    state.screen = "Usage credits confirmation\nContinue?";
  };
  const result = await models.select("one", {
    token: initial.picker.token,
    optionId: "0",
  });
  assert.deepEqual(calls, [["s"]]);
  assert.equal(result.pending, true);
  assert.equal(result.currentSource, "confirmed");
  assert.match(result.notice, /Terminal/);
});
test("opening uses draft-preserving native shortcuts, and never sends unknown inline model commands", async () => {
  for (const [tool, expected] of [
    ["claude", ["M-p"]],
    ["opencode", ["C-x", "m"]],
  ]) {
    const menu = await menuFixture(tool);
    const { sessions, state, calls } = fakeManager(
      tool,
      tool === "claude"
        ? "Claude Code\n❯ draft\n? for shortcuts"
        : "┃ Build · Big Pickle OpenCode Zen\nctrl+p commands",
    );
    state.onKeys = () => {
      state.screen = menu;
    };
    const models = new ModelController({ sessions, timeout: 100 });
    const result = await models.open("one");
    assert.ok(result.picker);
    assert.deepEqual(calls, [expected]);
  }
  const { sessions, calls } = fakeManager(
    "codex",
    "OpenAI Codex\n› existing draft\n? for shortcuts",
  );
  await assert.rejects(new ModelController({ sessions }).open("one"), /Terminal/);
  assert.deepEqual(calls, []);
});

test("open waits for delayed native rendering instead of returning the unchanged composer", async () => {
  const menu = await fixture(CLAUDE_MENU);
  const { sessions, state } = fakeManager(
    "claude",
    "Claude Code\n❯ draft\n? for shortcuts",
  );
  state.onKeys = () =>
    setTimeout(() => {
      state.screen = menu;
    }, 120);
  const result = await new ModelController({ sessions, timeout: 600 }).open("one");
  assert.ok(result.picker);
  assert.equal(result.pending, true);
});
test("input guard rejects native model menus even after a server restart", async () => {
  const model = new ModelController({ sessions: {} });
  assert.throws(
    () =>
      model.guardInput(
        "one",
        { tool: "codex" },
        "Select Model\n› 1. gpt-test (current)\nenter select · esc back",
      ),
    /Modellauswahl/,
  );
  assert.doesNotThrow(() =>
    model.guardInput("two", { tool: "claude" }, "Claude Code\n❯ draft\n? for shortcuts"),
  );
});

test("OpenCode search clears the whole native input even if its old text is clipped", async () => {
  const { sessions, state, calls } = fakeManager(
    "opencode",
    await fixture("opencode-model.ansi"),
  );
  // The screen only exposes the visible tail of an arbitrarily long old query.
  state.screen = state.screen.replace("Search", "clipped-tail");
  const model = new ModelController({ sessions, timeout: 100 });
  const initial = await model.read("one");
  await model.search("one", { token: initial.picker.token, query: "Pickle" });
  assert.deepEqual(calls, [
    ["C-e", "C-u"],
    ["text", "Pickle"],
  ]);
});

test("a quoted model menu above the native composer cannot be mistaken for an active picker", async () => {
  const quoted = await fixture("codex-0160-model-select.ansi");
  assert.equal(
    parseModelPicker(
      "codex",
      quoted + "\n› \x1b[2mAsk Codex to do anything\x1b[0m\n  gpt-6-astra default",
    ),
    null,
  );
  const claude = await fixture(CLAUDE_MENU);
  assert.equal(parseModelPicker("claude", claude + "\n❯ \n  ? for shortcuts"), null);
});

test("Codex readiness accepts trimmed empty prompts and ignores old tool status text", () => {
  assert.equal(modelPromptReady("codex", "Answer complete.\n›\n? for shortcuts"), true);
  const oldOutput = "Tool log: esc to interrupt, waiting for approval, Enter to confirm";
  assert.equal(
    modelPromptReady(
      "codex",
      `${oldOutput}\n\nAnswer complete.\n› \x1b[2mAsk anything\x1b[0m\n? for shortcuts`,
    ),
    true,
  );
  for (const screen of [
    "Answer complete.\n› actual draft\n? for shortcuts",
    "Answer complete.\n›\nDo you approve? Enter to confirm\n? for shortcuts",
    "Viewing sub-agent\n›\n? for shortcuts",
  ])
    assert.equal(modelPromptReady("codex", screen), false);
});

test("Codex ready prompt tolerates terminal padding while a stale prompt above a dialog does not", () => {
  assert.equal(
    modelPromptReady(
      "codex",
      "Answer complete.\n›\n? for shortcuts" + "\n\x1b[0m   ".repeat(20),
    ),
    true,
  );
  assert.equal(
    modelPromptReady("codex", "›\n? for shortcuts\n" + "dialog option\n".repeat(12)),
    false,
  );
});

test("Codex model switching opens and completes while the task keeps running", async () => {
  const busy = "• Working (12s • esc to interrupt)\n\n›\n? for shortcuts";
  const menu = await fixture("codex-0160-model-select.ansi");
  const { sessions, state, calls } = fakeManager("codex", busy);
  state.onKeys = () => {
    state.screen = menu;
  };
  const models = new ModelController({ sessions, timeout: 100 });
  const opened = await models.open("one");
  assert.ok(opened.picker);
  assert.deepEqual(calls, [["text", "/model"], ["Enter"]]);
  state.onKeys = () => {
    state.screen = busy;
  };
  const selected = await models.select("one", {
    token: opened.picker.token,
    optionId: opened.picker.selected,
  });
  assert.equal(selected.pending, false);
  assert.equal(selected.picker, null);
  assert.deepEqual(calls.at(-1), ["Enter"]);
  assert.doesNotThrow(() => models.guardInput("one", { tool: "codex" }, busy));
});

test("Codex model opening protects multiline drafts starting with a blank line", async () => {
  const screen =
    "• Working (12s • esc to interrupt)\n\n›\n  existing multiline draft\n? for shortcuts";
  assert.equal(modelPromptReady("codex", screen), false);
  const { sessions, calls } = fakeManager("codex", screen);
  await assert.rejects(new ModelController({ sessions }).open("one"), { status: 409 });
  assert.deepEqual(calls, []);
  assert.equal(
    modelPromptReady("codex", "› \x1b[2mA wrapped\nplaceholder\x1b[0m\n? for shortcuts"),
    true,
  );
});

for (const [tool, busy, shortcut, confirmation] of [
  [
    "claude",
    "Claude Code\n✻ Working… (12s · esc to interrupt)\n────────────\n❯ existing draft\n────────────\nbypass permissions on (shift+tab to cycle)",
    ["M-p"],
    "s",
  ],
  [
    "opencode",
    "┃ Build · Big Pickle OpenCode Zen\n┃ existing draft\n╹━━━━━━━━━━━━━━━━\nesc interrupt",
    ["C-x", "m"],
    "Enter",
  ],
])
  test(`${tool} can switch model during a running task using its draft-preserving shortcut`, async () => {
    const menu = await menuFixture(tool);
    const { sessions, state, calls } = fakeManager(tool, busy);
    state.onKeys = () => {
      state.screen = menu;
    };
    const models = new ModelController({ sessions, timeout: 100 });
    const opened = await models.open("one");
    assert.ok(opened.picker);
    assert.deepEqual(calls, [shortcut]);
    state.onKeys = () => {
      state.screen = busy;
    };
    const selected = await models.select("one", {
      token: opened.picker.token,
      optionId: opened.picker.selected,
    });
    assert.equal(selected.pending, false);
    assert.deepEqual(calls, [shortcut, [confirmation]]);
  });

test("Claude skip-permissions footer alone still marks the composer ready for /model", () => {
  const screen =
    "Answer complete.\n\n────────────────────────\n❯ \n────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)";
  assert.equal(modelPromptReady("claude", screen), true);
  assert.equal(
    modelPromptReady(
      "claude",
      `${screen.replace("Answer complete.", "")}\nDo you want to proceed?`,
    ),
    false,
  );
});
