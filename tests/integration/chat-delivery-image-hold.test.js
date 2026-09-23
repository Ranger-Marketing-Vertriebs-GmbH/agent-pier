import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import * as chat from "../../server/features/sessions/session-chat-input.js";
import { ChatDelivery } from "../../server/features/chat/chat-delivery.js";
import { claudeModelManager, claudePromptModel } from "../helpers/claude-prompt-model.js";

// The real delivery, queue and Claude input stack against the prompt model.
const screens = JSON.parse(
  fs.readFileSync(
    new URL("../fixtures/tui-input/claude-2.1.280-screens.json", import.meta.url),
  ),
);
const session = { id: "one", accountId: "fixture", tool: "claude", createdAt: "x" };
const scope = JSON.stringify(["one", "fixture", "claude", "x"]);

function setup(t, model, files = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-hold-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  for (const [index, name] of ["image 1.png", "image 2.png"].entries()) {
    files[index] = path.join(dataDir, name);
    fs.writeFileSync(files[index], "synthetic transport fixture");
  }
  const manager = claudeModelManager(model, { createdAt: "x" });
  manager.chatInputTiming = {
    dialog: { settleMs: 30, waitMs: 30 },
    clear: { settleMs: 30, timeoutMs: 400 },
    confirm: { timeoutMs: 300 },
  };
  const requests = {
    pending: false,
    list: async () => ({ requests: requests.pending ? [{ id: "r" }] : [] }),
    hasPending: () => requests.pending,
  };
  const delivery = new ChatDelivery({
    dataDir,
    sessions: {
      get: async () => session,
      withChatInput: (id, operation) => chat.withChatInput(manager, id, operation),
    },
    requests,
    models: { guardInput: () => {} },
    retryMs: 20,
  });
  const send = (text) =>
    delivery.send("one", {
      deliveryId: randomUUID(),
      deliveryScope: scope,
      text,
      submit: true,
    });
  const settled = async (deliveryId) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const result = await delivery.status("one", deliveryId, scope);
      if (result.status !== "pending") return result;
      await sleep(10);
    }
    assert.fail("still pending");
  };
  return { manager, delivery, requests, send, settled };
}

const pastes = (manager) =>
  manager.events.filter((e) => e.args[0] === "load-buffer").map((e) => e.input);
const phase = (x, deliveryId) =>
  JSON.parse(fs.readFileSync(x.delivery.file("one", deliveryId))).journal.phase;

// Opens a permission prompt once the n-th paste reached the prompt.
function questionAfter(model, manager, pasteNumber) {
  const tmux = manager.tmux;
  let seen = 0;
  manager.tmux = async (args, options) => {
    const result = await tmux(args, options);
    if (args[0] === "paste-buffer" && ++seen === pasteNumber)
      model.dialog = screens.permission;
    return result;
  };
}

test("a question after the image chips holds the text, then pastes only the text", async (t) => {
  const model = claudePromptModel({ images: true });
  const files = [];
  const x = setup(t, model, files);
  questionAfter(model, x.manager, 1);
  const held = await x.send(["Describe these", ...files].join("\n"));
  assert.equal(held.status, "pending");
  assert.equal(held.waiting, "dialog");
  assert.equal(phase(x, held.deliveryId), "images-pasted");
  await sleep(150);
  // Never Enter, Escape or text into the question; the chips stay.
  assert.deepEqual(model.keys, []);
  assert.deepEqual(model.dialogInput, []);
  assert.deepEqual(pastes(x.manager), [files.join("\n")]);
  // Images are in the prompt: cancelling is refused.
  await assert.rejects(x.delivery.cancel("one", held.deliveryId, scope), { status: 409 });
  model.dialog = null;
  assert.equal((await x.settled(held.deliveryId)).status, "handed-off");
  assert.deepEqual(pastes(x.manager), [files.join("\n"), "Describe these"]);
  assert.deepEqual(model.submitted, ["[Image #1] [Image #2]Describe these"]);
});

test("a question after the text holds Enter with chips and text as proof", async (t) => {
  const model = claudePromptModel({ images: true });
  const files = [];
  const x = setup(t, model, files);
  questionAfter(model, x.manager, 2);
  const held = await x.send(["Describe these", ...files].join("\n"));
  assert.equal(held.status, "pending");
  assert.equal(phase(x, held.deliveryId), "pasted");
  model.dialog = null;
  assert.equal((await x.settled(held.deliveryId)).status, "handed-off");
  assert.deepEqual(pastes(x.manager), [files.join("\n"), "Describe these"]);
  assert.deepEqual(model.submitted, ["[Image #1] [Image #2]Describe these"]);
});

test("chips changed while the text waited are never completed blindly", async (t) => {
  const model = claudePromptModel({ images: true });
  const files = [];
  const x = setup(t, model, files);
  questionAfter(model, x.manager, 1);
  const held = await x.send(["Describe these", ...files].join("\n"));
  assert.equal(held.status, "pending");
  model.lines = ["[Image #1]"];
  model.col = model.lines[0].length;
  model.dialog = null;
  const done = await x.settled(held.deliveryId);
  assert.equal(done.status, "uncertain");
  assert.equal(done.reason, "CHAT_PROMPT_CHANGED");
  assert.deepEqual(pastes(x.manager), [files.join("\n")]);
  assert.deepEqual(model.submitted, []);
});

test("an image-only message is held and submitted without a text step", async (t) => {
  const model = claudePromptModel({ images: true });
  const files = [];
  const x = setup(t, model, files);
  questionAfter(model, x.manager, 1);
  const held = await x.send(files.join("\n"));
  assert.equal(held.status, "pending");
  assert.equal(phase(x, held.deliveryId), "pasted");
  model.dialog = null;
  assert.equal((await x.settled(held.deliveryId)).status, "handed-off");
  assert.deepEqual(pastes(x.manager), [files.join("\n")]);
  assert.deepEqual(model.submitted, ["[Image #1] [Image #2]"]);
});
