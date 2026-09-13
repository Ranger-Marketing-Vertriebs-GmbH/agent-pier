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
test("native Claude menu exposes available models and the actual default resolution", async () => {
  const raw = await fixture("claude-model.ansi");
  const menu = parseModelPicker("claude", raw);
  assert.equal(menu.kind, "model");
  assert.equal(menu.options.length, 4);
  assert.equal(menu.options[0].current, true);
  assert.match(menu.currentModel, /Opus 5/);
  assert.equal(menu.selectKey, "s");
  assert.equal(menu.options[2].label, "Sonnet");
});
for (const width of [50, 80]) {
  test(`Claude model selection reads wrapped native menus at ${width} columns`, async () => {
    const raw = await fixture(`claude-model-${width}.txt`);
    const menu = parseModelPicker("claude", raw);
    assert.ok(menu, "the native picker must be available in chat");
    assert.equal(menu.options.length, 6);
    assert.equal(menu.selected, "5");
    assert.equal(menu.currentModel, "Sonnet 4.6");
    assert.equal(menu.selectKey, "s", "changing the session must not change the default");
    assert.equal(
      menu.options[0].description,
      "Use the default model (currently Opus 5 (1M context)) · $5/$25 per Mtok",
    );
    assert.equal(
      menu.options[5].description,
      "Newer version available · select Sonnet for Sonnet 5",
    );
    assert.equal(modelPromptReady("claude", raw), false);
    for (const suffix of ["\n❯\n? for shortcuts", "\n\n❯ draft\n? for shortcuts"])
      assert.equal(parseModelPicker("claude", raw + suffix), null);
  });
}
test("Codex model and reasoning stages remain distinct; current marker differs from highlight", async () => {
  const menu = parseModelPicker("codex", await fixture("codex-model.txt"));
  assert.equal(menu.kind, "model");
  assert.equal(menu.options.length, 6);
  assert.equal(menu.selected, "5");
  assert.equal(menu.currentModel, "gpt-5.2");
  const effort = parseModelPicker("codex", await fixture("codex-effort.txt"));
  assert.equal(effort.kind, "effort");
  assert.equal(effort.currentModel, null);
  assert.match(effort.title, /gpt-5.4/);
  assert.equal(effort.options.length, 6);
  assert.equal(
    parseModelPicker(
      "codex",
      "Approve command?\n› 1. Yes\n  2. No\nPress enter to confirm",
    ),
    null,
  );
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
  const menu = await fixture("claude-model-50.txt");
  const idle = "Claude Code\nSonnet 4.6 · API Usage Billing\n❯ draft\n? for shortcuts";
  const { sessions, state, calls } = fakeManager("claude", idle);
  state.onKeys = (keys) => {
    if (keys.join() === "M-p") state.screen = menu;
    if (keys.join() === "Up")
      state.screen = menu
        .replace("    5. Haiku", "  ❯ 5. Haiku")
        .replace("  ❯ 6.", "    6.");
    if (keys.join() === "s") state.screen = idle.replace("Sonnet 4.6", "Haiku 4.5");
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
  assert.equal(selected.currentModel, "Haiku 4.5");
  assert.equal(selected.pending, false);
  assert.equal(selected.picker, null);
  assert.doesNotThrow(() => models.guardInput("one", { tool: "claude" }, state.screen));
  const reopened = await models.open("one");
  const cancelled = await models.cancel("one", { token: reopened.picker.token });
  assert.equal(cancelled.pending, false);
  assert.deepEqual(calls, [["M-p"], ["Up"], ["s"], ["M-p"], ["Escape"]]);
});
test("Claude selection refuses default-only confirmation and keeps input blocked", async () => {
  const raw = (await fixture("claude-model-80.txt")).replace(
    " · s to use this session only",
    "",
  );
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
  const raw = await fixture("claude-model-80.txt");
  const legacy = raw.replace(
    "Enter to set as default · s to use this session only",
    "Enter to confirm",
  );
  const { sessions, state, calls } = fakeManager("claude", raw);
  const models = new ModelController({ sessions, timeout: 100 });
  const opened = await models.read("one");
  state.screen = "An old menu said: s to use this session only\n" + legacy;
  const current = await models.read("one");
  assert.equal(parseModelPicker("claude", state.screen).selectKey, "Enter");
  await assert.rejects(
    models.select("one", { token: opened.picker.token, optionId: "5" }),
    { status: 409 },
  );
  assert.deepEqual(calls, []);
  state.onKeys = () => {
    state.screen = "Claude Code\n❯\n? for shortcuts";
  };
  const selected = await models.select("one", {
    token: current.picker.token,
    optionId: "5",
  });
  assert.equal(selected.pending, false);
  assert.deepEqual(calls, [["Enter"]]);
});
test("stale menu tokens cannot send keys to another native screen", async () => {
  const { sessions, state, calls } = fakeManager(
    "claude",
    await fixture("claude-model.ansi"),
  );
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
  const { sessions, state, calls } = fakeManager(
    "claude",
    await fixture("claude-model.ansi"),
  );
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
    const menu = await fixture(tool + "-model.ansi");
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
  const menu = await fixture("claude-model.ansi");
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
        "Select Model\n› 1. gpt-test (current)\nPress enter to confirm or esc to go back",
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
  const quoted = await fixture("codex-model.txt");
  assert.equal(
    parseModelPicker(
      "codex",
      quoted + "\n› \x1b[2mAsk Codex to do anything\x1b[0m\n  gpt-6-astra default",
    ),
    null,
  );
  const claude = await fixture("claude-model.ansi");
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
  const menu = await fixture("codex-model.txt");
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
    const menu = await fixture(tool + "-model.ansi");
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
