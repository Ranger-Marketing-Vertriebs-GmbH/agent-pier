import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  nativePromptState,
  nativeFreshInput,
} from "../../server/features/sessions/native-prompt.js";

for (const tool of ["codex", "opencode"]) {
  const { frames } = JSON.parse(
    await fs.readFile(
      new URL(`../fixtures/tui-input/${tool}-prompt-spike.json`, import.meta.url),
      "utf8",
    ),
  );
  const input = (snapshot, extra = {}) =>
    nativeFreshInput({
      tool,
      snapshot,
      text: "AP_PROBE_DRAFT",
      timing: { timeoutMs: 10, settleMs: 1 },
      notice: async () => {},
      ...extra,
    });
  test(`${tool}: native prompt frames distinguish drafts, placeholders and menus`, () => {
    assert.equal(nativePromptState(tool, frames.idle).state, "empty");
    for (const name of ["short", "multiline", "long"]) {
      assert.equal(nativePromptState(tool, frames[name]).state, "draft", name);
      assert.equal(
        nativePromptState(tool, frames[`${name}-cleared`]).state,
        "empty",
        name,
      );
    }
    for (const name of [
      "model",
      "menu-50",
      "menu-36",
      "permission",
      "permission-50",
      "permission-36",
    ])
      assert.equal(nativePromptState(tool, frames[name]).state, "dialog", name);
  });
  test(`${tool}: a menu receives neither editing keys nor Enter`, async () => {
    const guard = input(async () => frames.model, {
      manager: { tmux: () => assert.fail("Unexpected key"), target: () => "fixture" },
      session: { id: "fixture" },
    });
    await assert.rejects(guard.prepare(frames.model), { code: "CHAT_DIALOG_NOT_CLOSED" });
    await assert.rejects(guard.beforeSubmit(), { code: "CHAT_DIALOG_NOT_CLOSED" });
  });
  test(`${tool}: lost paste cannot receive Enter`, async () => {
    await assert.rejects(input(async () => frames.idle).beforeSubmit(), {
      code: "CHAT_SUBMIT_UNCONFIRMED",
    });
  });
  test(`${tool}: a stuck submitted draft is uncertain`, async () => {
    await assert.rejects(input(async () => frames.short).confirm({}), {
      code: "CHAT_SUBMIT_UNCONFIRMED",
    });
    await input(async () => frames.idle).confirm({});
  });
  test(`${tool}: a held Enter requires unchanged proven content`, async () => {
    let frame = frames.short,
      proof;
    const guard = input(async () => frame, {
      onProof: (value) => {
        proof = value;
      },
    });
    await guard.afterPaste();
    assert.ok(proof);
    await guard.beforeResubmit(proof, () => false);
    frame = frames.long;
    await assert.rejects(
      guard.beforeResubmit(proof, () => false),
      { code: "CHAT_PROMPT_CHANGED" },
    );
  });
  test(`${tool}: stalled clearing falls back to a separated draft with a notice`, async () => {
    const notices = [],
      keys = [];
    const guard = input(async () => frames.short, {
      notice: async (code) => notices.push(code),
      manager: {
        target: () => "fixture",
        tmux: async (args) => keys.push(args.slice(3)),
      },
      session: { id: "fixture" },
    });
    await guard.prepare(frames.short);
    assert.deepEqual(notices, ["CHAT_APPENDED_TO_DRAFT"]);
    assert.equal(guard.pastePrefix(), "\n");
    assert.ok(keys.length);
    assert.ok(keys.flat().every((key) => !["Escape", "C-c", "Enter"].includes(key)));
  });
}

test("Codex keeps blank and indented continuation rows inside the draft", async () => {
  const { frames } = JSON.parse(
    await fs.readFile(
      new URL("../fixtures/tui-input/codex-prompt-spike.json", import.meta.url),
      "utf8",
    ),
  );
  for (const continuation of ["", "  ", "    indented"]) {
    const frame = {
      ...frames.multiline,
      raw: frames.multiline.raw.replace("  second", continuation),
    };
    assert.equal(nativePromptState("codex", frame).state, "draft");
  }
  let proof;
  const guard = nativeFreshInput({
    tool: "codex",
    snapshot: async () => frames.long,
    text: "AP_PROBE_LONG_" + "x".repeat(300),
    onProof: (value) => {
      proof = value;
    },
  });
  await guard.afterPaste();
  assert.ok(proof);
  await guard.beforeResubmit(proof, () => false);
});

test("OpenCode prefers an active composer to earlier permission output", async () => {
  const { frames } = JSON.parse(
    await fs.readFile(
      new URL("../fixtures/tui-input/opencode-prompt-spike.json", import.meta.url),
      "utf8",
    ),
  );
  const rows = frames.idle.raw.split("\n");
  rows[frames.idle.pane.cursorY - 5] = "  ┃  △ Permission required";
  const frame = {
    ...frames.idle,
    pane: { ...frames.idle.pane, height: 24 },
    raw: rows.join("\n"),
  };
  assert.equal(nativePromptState("opencode", frame).state, "empty");
});

test("a dialog before image one leaves the journal reserved", async () => {
  const { writeChatImages } =
    await import("../../server/features/sessions/chat-image-input.js");
  const phases = [];
  await assert.rejects(
    writeChatImages({
      session: { tool: "codex" },
      images: { images: ["/fixture/image.png"], text: "Describe" },
      onPhase: async (p) => phases.push(p),
      onDialog: async () => {
        throw Object.assign(Error("Dialog"), { code: "CHAT_DIALOG_NOT_CLOSED" });
      },
      paste: () => assert.fail("Unexpected paste"),
    }),
    { code: "CHAT_DIALOG_NOT_CLOSED" },
  );
  assert.deepEqual(phases, []);
});
