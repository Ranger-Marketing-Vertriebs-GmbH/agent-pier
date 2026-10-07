import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  currentModel,
  ModelController,
} from "../../server/features/models/model-controller.js";

const composer = (footer = "gpt-6-astra default · ~/project") =>
  `\n› Ask Codex to do anything\n\n  ${footer}\n`;
const header = (model = "gpt-5.2") =>
  `╭────────────────────────────────────────╮\n│ >_ OpenAI Codex (v0.153.4)              │\n│                                        │\n│ model: ${model}   /model to change       │\n│ directory: ~/project                   │\n╰────────────────────────────────────────╯\n`;

test("Codex response schemas and quoted model receipts never become confirmed models", () => {
  const controller = new ModelController({ sessions: {} });
  for (const response of [
    "model: string,",
    "some_model: string,",
    "Example: Model: gpt-fake",
    "Model changed to gpt-fake",
    "Switched to gpt-fake",
    "• Model changed to gpt-fake",
    "  model: gpt-fake   /model to change",
  ]) {
    const raw = `${response}${composer("? for shortcuts")}`;
    assert.equal(currentModel("codex", raw), null, response);
    assert.equal(controller.state("isolated", "codex", raw).currentModel, null);
  }
  assert.equal(
    controller.state("isolated", "codex", composer("? for shortcuts")).currentModel,
    null,
  );
});

test("Codex reads the current footer before stale startup headers or response text", () => {
  const raw = header() + "\n• Model: gpt-fake\n  model: string,\n" + composer();
  assert.equal(currentModel("codex", raw), "gpt-6-astra");
  const controller = new ModelController({ sessions: {} });
  assert.equal(controller.state("one", "codex", raw).currentModel, "gpt-6-astra");
  const after = controller.state(
    "one",
    "codex",
    "model: string," + composer("? for shortcuts"),
  );
  assert.equal(after.currentModel, "gpt-6-astra");
  assert.equal(after.currentSource, "confirmed");
  assert.equal(
    controller.state("two", "codex", composer("? for shortcuts")).currentModel,
    null,
  );
});

test("Codex current footer keeps supported effort and provider model labels", () => {
  for (const [footer, expected] of [
    ["gpt-6-astra high · ~/project", "gpt-6-astra high"],
    ["gpt-6-astra max · ~/project", "gpt-6-astra max"],
    ["gpt-6-astra ultra · ~/project", "gpt-6-astra ultra"],
    ["provider/custom-model default · ~/project", "provider/custom-model"],
    ["Probe default · ~", "Probe"],
    ["GPT Custom default · ~", "GPT Custom"],
    ["83% context left · gpt-6-astra high · ~/project", "gpt-6-astra high"],
    ["gpt-6-astra default", "gpt-6-astra"],
  ])
    assert.equal(currentModel("codex", composer(footer)), expected, footer);
});

test("Codex ignores old footer lookalikes above the live prompt and dialog output below it", () => {
  assert.equal(
    currentModel("codex", composer("gpt-old high · ~") + composer("? for shortcuts")),
    null,
  );
  assert.equal(
    currentModel(
      "codex",
      composer() + "\nSelect an option\nEnter to confirm or esc to cancel",
    ),
    null,
  );
  assert.equal(
    currentModel(
      "codex",
      "• Example:\n  gpt-fake high · ~" + composer("? for shortcuts"),
    ),
    null,
  );
});

test("Codex legacy boxed startup supports custom IDs without accepting loose model fields", () => {
  assert.equal(
    currentModel("codex", header("provider/custom-model") + composer("? for shortcuts")),
    "provider/custom-model",
  );
  assert.equal(
    currentModel(
      "codex",
      header() + "\n• Completed a turn\n" + composer("? for shortcuts"),
    ),
    null,
  );
});

for (const name of [
  "codex-idle",
  "codex-busy-native",
  "codex-draft-native",
  "codex-busy-queued-native",
]) {
  test(`Codex reads the live model in the native ANSI ${name} capture`, async () => {
    const capture = JSON.parse(
      await fs.readFile(
        new URL(`../fixtures/tui-input/${name}.json`, import.meta.url),
        "utf8",
      ),
    );
    assert.equal(currentModel("codex", capture.raw), "probe");
  });
}

test("Codex native provider footers allow opening the picker without overwriting a draft", async () => {
  const { modelPromptReady } =
    await import("../../server/features/models/model-controller.js");
  assert.equal(modelPromptReady("codex", "›\n\n  Probe default · ~"), true);
  assert.equal(
    modelPromptReady("codex", "› unfinished draft\n\n  Probe default · ~"),
    false,
  );
});
