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

function setup(t, model) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-hold-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
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

// Opens a permission prompt after our paste was seen, before Enter.
function questionAfterPaste(model, manager, { immediately = false } = {}) {
  const tmux = manager.tmux;
  let captures = -1;
  manager.tmux = async (args, options) => {
    if (args[0] === "paste-buffer") captures = 0;
    else if (args[0] === "display-message" && captures >= 0) captures++;
    const result = await tmux(args, options);
    if (!model.opened && captures >= (immediately ? 0 : 2)) {
      model.opened = true;
      model.dialog = screens.permission;
    }
    return result;
  };
}

test("text held behind a question after its paste keeps waiting, then gets Enter", async (t) => {
  const model = claudePromptModel();
  const x = setup(t, model);
  questionAfterPaste(model, x.manager);
  const held = await x.send("first line\nsecond line");
  assert.equal(held.status, "pending");
  assert.equal(held.waiting, "dialog");
  assert.equal(held.pasted, true);
  // Still open across several retries: never Escape, never Enter, still pending.
  await sleep(200);
  assert.deepEqual(model.keys, []);
  assert.equal(
    (await x.delivery.status("one", held.deliveryId, scope)).status,
    "pending",
  );
  // Cancelling is refused once the text is in the prompt.
  await assert.rejects(x.delivery.cancel("one", held.deliveryId, scope), { status: 409 });
  model.dialog = null;
  const done = await x.settled(held.deliveryId);
  assert.equal(done.status, "handed-off");
  // Multi-line text is submitted once, because the prompt box is unchanged.
  assert.deepEqual(model.submitted, ["first line\nsecond line"]);
});

test("an appended message held after its paste is submitted with its draft", async (t) => {
  const model = claudePromptModel({ draft: "typed draft" });
  const key = model.key;
  model.key = (name) =>
    ["C-e", "C-u", "BSpace", "DC"].includes(name) ? model.keys.push(name) : key(name);
  const x = setup(t, model);
  questionAfterPaste(model, x.manager);
  const held = await x.send("chat text");
  assert.equal(held.status, "pending");
  model.dialog = null;
  const done = await x.settled(held.deliveryId);
  assert.equal(done.status, "handed-off");
  assert.deepEqual(done.notices, ["CHAT_APPENDED_TO_DRAFT"]);
  assert.deepEqual(model.submitted, ["typed draft\nchat text"]);
});

test("a prompt edited while the message waited is never submitted blindly", async (t) => {
  const model = claudePromptModel();
  const x = setup(t, model);
  questionAfterPaste(model, x.manager);
  const held = await x.send("original");
  model.dialog = null;
  model.insert(" plus user edit");
  const done = await x.settled(held.deliveryId);
  assert.equal(done.status, "uncertain");
  assert.equal(done.reason, "CHAT_PROMPT_CHANGED");
  assert.deepEqual(model.submitted, []);
});

test("later messages queue behind a held one and keep their order", async (t) => {
  const model = claudePromptModel();
  const x = setup(t, model);
  x.requests.pending = true;
  const first = await x.send("first");
  const second = await x.send("second");
  const third = await x.send("third");
  assert.equal(first.waiting, "request");
  assert.equal(second.waiting, "queue");
  assert.equal(third.waiting, "queue");
  // The user cancels the second one; nothing was typed yet.
  const cancelled = await x.delivery.cancel("one", second.deliveryId, scope);
  assert.equal(cancelled.status, "rejected");
  assert.equal(cancelled.reason, "CHAT_CANCELLED");
  x.requests.pending = false;
  assert.equal((await x.settled(third.deliveryId)).status, "handed-off");
  assert.equal((await x.settled(first.deliveryId)).status, "handed-off");
  assert.deepEqual(model.submitted, ["first", "third"]);
});

test("without a proof, held pasted text still waits for the dialog and needs an exact match", async (t) => {
  const model = claudePromptModel();
  const x = setup(t, model);
  questionAfterPaste(model, x.manager, { immediately: true });
  const held = await x.send("single line");
  assert.equal(held.status, "pending");
  await sleep(150);
  assert.equal(
    (await x.delivery.status("one", held.deliveryId, scope)).status,
    "pending",
  );
  model.dialog = null;
  const done = await x.settled(held.deliveryId);
  assert.equal(done.status, "handed-off");
  assert.deepEqual(model.submitted, ["single line"]);
});

test("redelivery after a restart also holds for an open request instead of refusing", async (t) => {
  const model = claudePromptModel();
  const x = setup(t, model);
  x.requests.pending = true;
  const held = await x.send("after restart");
  // Simulate a restart: the in-memory hold is gone, the receipt is uncertain.
  x.delivery.held.queues.clear();
  x.delivery.active.clear();
  const interrupted = await x.delivery.status("one", held.deliveryId, scope);
  assert.equal(interrupted.status, "uncertain");
  assert.equal(interrupted.pasted, false);
  const recovery = await x.delivery.recover("one", held.deliveryId, {
    attemptId: randomUUID(),
    expectedAttemptId: held.deliveryId,
    deliveryScope: scope,
    text: "after restart",
    mode: "retry",
  });
  assert.equal(recovery.status, "pending");
  assert.equal(recovery.recovery.action, "held");
  x.requests.pending = false;
  assert.equal((await x.settled(held.deliveryId)).status, "handed-off");
  assert.deepEqual(model.submitted, ["after restart"]);
});
