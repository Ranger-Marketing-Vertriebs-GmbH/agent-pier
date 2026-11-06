import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import * as chat from "../../server/features/sessions/session-chat-input.js";
import { ChatDelivery } from "../../server/features/chat/chat-delivery.js";
import { DeliveryAcceptance } from "../../server/features/chat/delivery-acceptance.js";
import { clearBlockedPrompt } from "../../server/features/chat/chat-delivery-blocked.js";
import { claudeModelManager, claudePromptModel } from "../helpers/claude-prompt-model.js";

// The real delivery, matcher and Claude input stack against the prompt model.
const session = { id: "one", accountId: "fixture", tool: "claude", createdAt: "x" };
const scope = JSON.stringify(["one", "fixture", "claude", "x"]);
const interrupting = ["Escape", "C-c"];

function setup(t, model, { afterSubmit } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-blocked-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const manager = claudeModelManager(model, { createdAt: "x" });
  manager.chatInputTiming = {
    dialog: { settleMs: 30, waitMs: 30 },
    clear: { settleMs: 30, timeoutMs: 400 },
    confirm: { timeoutMs: 300 },
  };
  if (afterSubmit) {
    const tmux = manager.tmux;
    manager.tmux = async (args, options) => {
      const result = await tmux(args, options);
      if (args[0] === "send-keys" && args.includes("Enter")) afterSubmit();
      return result;
    };
  }
  let delivery;
  const acceptance = new DeliveryAcceptance({
    onMatch: (id, deliveryId, outcome) => delivery.accept(id, deliveryId, outcome),
  });
  acceptance.ready(session.id, {});
  delivery = new ChatDelivery({
    dataDir,
    acceptance,
    sessions: {
      get: async () => session,
      withChatInput: (id, operation) => chat.withChatInput(manager, id, operation),
    },
    requests: {
      list: async () => ({ requests: [] }),
      hasPending: () => false,
      clearNotice: () => {},
    },
    models: { guardInput: () => {} },
    retryMs: 20,
  });
  const send = (text) =>
    delivery.send(session.id, {
      deliveryId: randomUUID(),
      deliveryScope: scope,
      text,
      submit: true,
    });
  // Claude puts a prompt its hook blocked back into its own prompt box.
  const drop = (reason) =>
    acceptance.report(session.id, {
      kind: "dropped",
      at: Date.now(),
      imageNames: null,
      imageCount: 0,
      ...(reason === undefined ? {} : { reason }),
    });
  const rejected = async (deliveryId) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const result = await delivery.status(session.id, deliveryId, scope);
      if (result.status === "rejected") return result;
      await sleep(10);
    }
    assert.fail("never rejected");
  };
  return { model, manager, delivery, send, drop, rejected };
}

const restore = (model, text) => {
  model.lines = text.split("\n");
  model.line = model.lines.length - 1;
  model.col = model.lines.at(-1).length;
};

test("blocked prompt is cleared and released", async (t) => {
  const model = claudePromptModel();
  const x = setup(t, model);
  const sent = await x.send("first line\nsecond line");
  assert.equal(sent.status, "handed-off");
  restore(model, "first line\nsecond line");
  model.keys.length = 0;
  x.drop("Blocked:\x1b[31m secrets\x1b[0m\nin the prompt\x07" + "x".repeat(600));
  const result = await x.rejected(sent.deliveryId);
  assert.equal(result.reason, "CHAT_HOOK_BLOCKED");
  assert.equal(result.released, true);
  assert.equal(typeof result.error, "string");
  assert.equal(result.hookReason.length, 500);
  assert.ok(result.hookReason.startsWith("Blocked: secrets in the prompt"));
  assert.doesNotMatch(result.hookReason, /[\x00-\x1f\x7f-\x9f]/);
  assert.deepEqual(model.lines, [""]);
  assert.ok(model.keys.length > 0);
  assert.ok(model.keys.every((key) => !interrupting.includes(key) && key !== "Enter"));
  // Exactly the delivered prompt was submitted once, never again.
  assert.deepEqual(model.submitted, ["first line\nsecond line"]);
});

test("already empty box releases", async (t) => {
  const model = claudePromptModel();
  const x = setup(t, model);
  const sent = await x.send("hello");
  model.keys.length = 0;
  x.drop();
  const result = await x.rejected(sent.deliveryId);
  assert.equal(result.reason, "CHAT_HOOK_BLOCKED");
  assert.equal(result.released, true);
  assert.equal(result.hookReason, undefined);
  assert.deepEqual(model.keys, []);
});

test("foreign draft is never cleared", async (t) => {
  const model = claudePromptModel();
  const x = setup(t, model);
  const sent = await x.send("hello");
  // The owner typed in the TUI meanwhile: the box holds more than our text.
  restore(model, "hello and more");
  model.keys.length = 0;
  x.drop("Blocked");
  const result = await x.rejected(sent.deliveryId);
  assert.equal(result.reason, "CHAT_HOOK_BLOCKED_DRAFT");
  assert.equal(result.released, false);
  assert.equal(result.hookReason, "Blocked");
  assert.deepEqual(model.keys, []);
  assert.deepEqual(model.lines, ["hello and more"]);
});

test("blocked uncertain receipt behaves the same", async (t) => {
  const model = claudePromptModel();
  // Enter reaches Claude, but the prompt box never shows it empty.
  let x;
  x = setup(t, model, {
    afterSubmit: () => {
      model.ignoreEnter = true;
      restore(model, "hello");
    },
  });
  model.ignoreEnter = false;
  const sent = await x.send("hello");
  assert.equal(sent.status, "uncertain");
  model.keys.length = 0;
  x.drop("Blocked");
  const result = await x.rejected(sent.deliveryId);
  assert.equal(result.reason, "CHAT_HOOK_BLOCKED");
  assert.equal(result.released, true);
  assert.deepEqual(model.lines, [""]);
  assert.ok(model.keys.every((key) => !interrupting.includes(key) && key !== "Enter"));
});

test("a drop while the delivery still runs is applied when it finishes", async (t) => {
  const model = claudePromptModel();
  let x;
  x = setup(t, model, {
    afterSubmit: () => {
      restore(model, "hello");
      x.drop("Blocked");
    },
  });
  const sent = await x.send("hello");
  const result = await x.rejected(sent.deliveryId);
  assert.equal(result.reason, "CHAT_HOOK_BLOCKED");
  assert.equal(result.released, true);
  assert.deepEqual(model.lines, [""]);
});

test("an accepted receipt is never turned into a block", async (t) => {
  const model = claudePromptModel();
  const x = setup(t, model);
  const sent = await x.send("hello");
  x.delivery.accept(session.id, sent.deliveryId, { kind: "accepted" });
  restore(model, "hello");
  model.keys.length = 0;
  x.delivery.accept(session.id, sent.deliveryId, { kind: "dropped" });
  await sleep(100);
  const result = await x.delivery.status(session.id, sent.deliveryId, scope);
  assert.equal(result.status, "accepted");
  assert.deepEqual(model.keys, []);
});

test("an unreadable session is treated as a foreign draft", async () => {
  const sessions = {
    withChatInput: async () => {
      throw new Error("Session gone");
    },
  };
  assert.equal(
    await clearBlockedPrompt({ sessions, id: "one", text: "hello" }),
    "foreign",
  );
});

// Codex frames recorded from the real CLI (tests/fixtures/tui-input).
const codexFrames = JSON.parse(
  fs.readFileSync(
    new URL("../fixtures/tui-input/codex-prompt-spike.json", import.meta.url),
  ),
).frames;

function codexSessions(frame) {
  const model = {
    frame,
    keys: [],
    screen: () => model.frame,
    key(name) {
      model.keys.push(name);
      if (name === "C-u" && model.frame === codexFrames.short)
        model.frame = codexFrames["short-cleared"];
    },
  };
  const manager = claudeModelManager(model, { tool: "codex" });
  manager.chatInputTiming = { timeoutMs: 200, settleMs: 5 };
  return {
    model,
    sessions: {
      withChatInput: (id, operation) => chat.withChatInput(manager, id, operation),
    },
  };
}

test("Codex: a blocked prompt is cleared with editing keys only", async () => {
  const x = codexSessions(codexFrames.short);
  const result = await clearBlockedPrompt({
    sessions: x.sessions,
    id: "one",
    text: "AP_PROBE_DRAFT",
  });
  assert.equal(result, "cleared");
  assert.equal(x.model.frame, codexFrames["short-cleared"]);
  assert.ok(x.model.keys.every((key) => !interrupting.includes(key) && key !== "Enter"));
});

test("Codex: a different draft is never cleared", async () => {
  const x = codexSessions(codexFrames.short);
  const result = await clearBlockedPrompt({
    sessions: x.sessions,
    id: "one",
    text: "something else",
  });
  assert.equal(result, "foreign");
  assert.deepEqual(x.model.keys, []);
});

test("Codex: an empty prompt box needs no keys", async () => {
  const x = codexSessions(codexFrames.idle);
  const result = await clearBlockedPrompt({
    sessions: x.sessions,
    id: "one",
    text: "AP_PROBE_DRAFT",
  });
  assert.equal(result, "empty");
  assert.deepEqual(x.model.keys, []);
});
