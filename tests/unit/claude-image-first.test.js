import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as chat from "../../server/features/sessions/session-chat-input.js";
import { claudeModelManager, claudePromptModel } from "../helpers/claude-prompt-model.js";

async function images(t, count) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-image-first-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = [];
  for (let n = 1; n <= count; n++) {
    files.push(path.join(directory, `image ${n}.png`));
    await fs.writeFile(files.at(-1), "synthetic transport fixture");
  }
  return files;
}

const long = "lorem ipsum dolor sit amet ".repeat(15).trim();
const pastes = (manager) =>
  manager.events.filter((event) => event.args[0] === "load-buffer").map((e) => e.input);
const keys = (manager) =>
  manager.events
    .filter((event) => event.args[0] === "send-keys")
    .map((e) => e.args.at(-1));

function send(manager, text, options = {}) {
  const phases = [];
  const refused = [];
  return chat
    .withChatInput(manager, "one", (tx) =>
      tx.write(text, {
        allowComposerDraft: true,
        onPhase: async (phase) => phases.push(phase),
        onRefused: async (phase) => refused.push(phase),
        ...options,
      }),
    )
    .then(
      () => ({ phases, refused }),
      (error) => ({ error, phases, refused }),
    );
}

test("Claude image messages paste the image paths first, then the text, then submit once", async (t) => {
  const files = await images(t, 3);
  const model = claudePromptModel({ images: true });
  const manager = claudeModelManager(model);
  const result = await send(manager, [long, ...files].join("\n"));
  assert.equal(result.error, undefined);
  assert.deepEqual(pastes(manager), [files.join("\n"), long]);
  assert.deepEqual(keys(manager), ["Enter"]);
  assert.deepEqual(result.phases, [
    "paste-intent",
    "images-pasted",
    "text-intent",
    "pasted",
    "submit-intent",
    "submitted",
  ]);
  assert.deepEqual(model.submitted, [`[Image #1] [Image #2] [Image #3]${long}`]);
});

test("image lines anywhere in the message are chips; the remaining lines keep their order", async (t) => {
  const [first, second] = await images(t, 2);
  const model = claudePromptModel({ images: true });
  const manager = claudeModelManager(model);
  const missing = `${first}.missing.png`;
  const text = `before\n${first}\n~/relative.png\n${missing}\n  ${second}  \nafter`;
  await send(manager, text);
  assert.deepEqual(pastes(manager), [
    `${first}\n${second}`,
    `before\n~/relative.png\n${missing}\nafter`,
  ]);
});

test("an image-only message is one paste without a text step", async (t) => {
  const files = await images(t, 2);
  const model = claudePromptModel({ images: true });
  const manager = claudeModelManager(model);
  const result = await send(manager, files.join("\n"));
  assert.deepEqual(pastes(manager), [files.join("\n")]);
  assert.deepEqual(result.phases, [
    "paste-intent",
    "images-pasted",
    "pasted",
    "submit-intent",
    "submitted",
  ]);
  assert.deepEqual(model.submitted, ["[Image #1] [Image #2]"]);
});

test("missing chips stop before the text is pasted", async (t) => {
  const files = await images(t, 2);
  const model = claudePromptModel({ images: true });
  const manager = claudeModelManager(model);
  // Claude shows only one chip: the second image never finishes loading.
  const paste = model.paste;
  model.paste = (text) => paste(text.includes("\n") ? text.split("\n")[0] : text);
  const result = await send(manager, ["Describe", ...files].join("\n"), {
    imageTimeoutMs: 200,
  });
  assert.equal(result.error.code, "CHAT_IMAGES_UNCONFIRMED");
  assert.deepEqual(result.phases, ["paste-intent", "images-pasted"]);
  assert.deepEqual(pastes(manager), [files.join("\n")]);
  assert.deepEqual(keys(manager), []);
});

test("a text paste that never renders after the chips is not submitted", async (t) => {
  const files = await images(t, 1);
  const model = claudePromptModel({ images: true });
  const manager = claudeModelManager(model);
  const paste = model.paste;
  model.paste = (text) => (text.startsWith("/") ? paste(text) : undefined);
  const result = await send(manager, ["Describe", ...files].join("\n"));
  assert.equal(result.error.code, "CHAT_SUBMIT_UNCONFIRMED");
  assert.deepEqual(result.refused, ["submit-intent"]);
  assert.deepEqual(keys(manager), []);
});

test("chips that vanish before the text step refuse the text intent", async (t) => {
  const files = await images(t, 1);
  const model = claudePromptModel({ images: true });
  const manager = claudeModelManager(model);
  const result = await send(manager, ["Describe", ...files].join("\n"), {
    onPhase: async (phase) => {
      if (phase === "text-intent") model.lines = ["something else"];
    },
  });
  assert.equal(result.error.code, "CHAT_IMAGES_UNCONFIRMED");
  assert.deepEqual(result.refused, ["text-intent"]);
  assert.deepEqual(pastes(manager), [files[0]]);
});

test("resuming after the images pastes only the text into its own chips", async (t) => {
  const files = await images(t, 2);
  const text = ["Describe", ...files].join("\n");
  // Chip numbers differ per Claude session; only their count and place matter.
  const model = claudePromptModel({ images: true, draft: "[Image #7] [Image #8]" });
  const manager = claudeModelManager(model);
  const result = await send(manager, text, { resume: "text" });
  assert.equal(result.error, undefined);
  assert.deepEqual(pastes(manager), ["Describe"]);
  assert.deepEqual(result.phases, [
    "text-intent",
    "pasted",
    "submit-intent",
    "submitted",
  ]);
  assert.deepEqual(model.submitted, ["[Image #7] [Image #8]Describe"]);
  for (const draft of ["[Image #7]", "[Image #7] [Image #8]x", "", "other"]) {
    const other = claudeModelManager(claudePromptModel({ images: true, draft }));
    const refused = await send(other, text, { resume: "text" });
    assert.equal(refused.error.status, 409, draft);
    assert.deepEqual(other.events, [], draft);
  }
  const plain = claudeModelManager(claudePromptModel({ draft: "" }));
  assert.equal((await send(plain, "no images", { resume: "text" })).error.status, 400);
});

test("submit-only matches an image draft with chips in place of the paths", async (t) => {
  const files = await images(t, 2);
  const text = ["Describe", ...files].join("\n");
  const model = claudePromptModel({
    images: true,
    draft: "[Image #3] [Image #4]Describe",
  });
  const manager = claudeModelManager(model);
  assert.equal((await send(manager, text, { submitOnly: true })).error, undefined);
  assert.deepEqual(keys(manager), ["Enter"]);
  for (const draft of [
    "[Image #3]Describe",
    "[Image #3] [Image #4]Describe more",
    "[Image #3] [Image #4] Describe",
    "Describe",
  ]) {
    const other = claudeModelManager(claudePromptModel({ images: true, draft }));
    const refused = await send(other, text, { submitOnly: true });
    assert.equal(refused.error.status, 409, draft);
    assert.deepEqual(other.events, [], draft);
  }
});

test("Codex and OpenCode keep one paste even with image paths", async (t) => {
  const files = await images(t, 1);
  const tmux = [];
  for (const tool of ["codex", "opencode"]) {
    const manager = {
      target: () => "=synthetic",
      tmux: async (args, options) => tmux.push([tool, args[0], options?.input]),
    };
    await chat.writeChatTuiInput(manager, { id: "x", tool }, `Look\n${files[0]}`);
  }
  assert.deepEqual(
    tmux.filter(([, command]) => command === "load-buffer").map(([, , input]) => input),
    [`Look\n${files[0]}`, `Look\n${files[0]}`],
  );
  assert.ok(!tmux.some(([, command]) => command === "display-message"));
});
