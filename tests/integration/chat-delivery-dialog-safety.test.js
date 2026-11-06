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

// Pins the guarantee that later delivery confirmation builds on: chat delivery
// never types into a native approval dialog that is already open.
//   Claude permission prompt, open before the delivery starts: this file.
//   Claude permission prompt, opening after the paste: chat-delivery-hold.test.js.
//   Codex approval dialog, before and after the paste, against real tmux bytes:
//   native-chat-dialog.test.js.
const screens = JSON.parse(
  fs.readFileSync(
    new URL("../fixtures/tui-input/claude-2.1.280-screens.json", import.meta.url),
  ),
);
const session = { id: "one", accountId: "fixture", tool: "claude", createdAt: "x" };
const scope = JSON.stringify(["one", "fixture", "claude", "x"]);

test("a Claude permission prompt open before delivery receives neither paste nor Enter", async (t) => {
  const model = claudePromptModel({ dialog: screens.permission });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-dialog-safety-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const manager = claudeModelManager(model, { createdAt: "x" });
  manager.chatInputTiming = {
    dialog: { settleMs: 30, waitMs: 30 },
    clear: { settleMs: 30, timeoutMs: 400 },
    confirm: { timeoutMs: 300 },
  };
  const delivery = new ChatDelivery({
    dataDir,
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
  const receipt = await delivery.send("one", {
    deliveryId: randomUUID(),
    deliveryScope: scope,
    text: "hello",
    submit: true,
  });
  assert.equal(receipt.status, "pending");
  assert.ok(["dialog", "request"].includes(receipt.waiting), receipt.waiting);
  // Several retries later the dialog is still untouched.
  await sleep(200);
  const still = await delivery.status("one", receipt.deliveryId, scope);
  assert.equal(still.status, "pending");
  assert.equal(model.dialogInput.length, 0, "nothing reached the open dialog");
  assert.deepEqual(model.keys, []);
  assert.deepEqual(model.submitted, []);
  const sent = manager.events.map((event) => event.args[0]);
  assert.equal(sent.includes("paste-buffer"), false);
  assert.equal(
    manager.events.some(
      (event) => event.args[0] === "send-keys" && event.args.includes("Enter"),
    ),
    false,
  );
  // Once the user closes the dialog, the message is delivered exactly once.
  model.dialog = null;
  let done = still;
  for (let n = 0; n < 300 && done.status === "pending"; n++) {
    await sleep(10);
    done = await delivery.status("one", receipt.deliveryId, scope);
  }
  assert.equal(done.status, "handed-off");
  assert.deepEqual(model.submitted, ["hello"]);
  assert.equal(model.dialogInput.length, 0);
});
