import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { claudeModelManager, claudePromptModel } from "../helpers/claude-prompt-model.js";
import { withChatInput } from "../../server/features/sessions/session-chat-input.js";
import { chatDeliveryCopy as copy } from "../../server/lib/i18n/de/chat-delivery.js";

const scope = JSON.stringify(["one", "fixture", "claude", null]);
const inputPath = "/api/sessions/one/input";

/**
 * Chat delivery over HTTP into a modeled Claude prompt that turns pasted image
 * paths into chips. `crash` aborts the send right after that journal phase is
 * durable, like a server stopping between two terminal writes.
 */
async function setup(t, { crash, images = 2, draft } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-image-recovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = [];
  for (let n = 1; n <= images; n++) {
    files.push(path.join(directory, `image ${n}.png`));
    fs.writeFileSync(files.at(-1), "synthetic transport fixture");
  }
  const f = await applicationFixture(t);
  const model = claudePromptModel({ images: true, draft });
  const manager = claudeModelManager(model);
  const delivery = f.application.chatDelivery;
  f.application.sessions.get = async () => manager.current();
  f.application.sessions.withChatInput = (id, operation) =>
    withChatInput(manager, id, operation);
  f.application.requests.list = async () => ({ requests: [] });
  f.application.requests.hasPending = () => false;
  f.application.models.guardInput = async () => {};
  const write = delivery.write.bind(delivery);
  let crashed = !crash;
  delivery.write = (file, receipt) => {
    write(file, receipt);
    if (!crashed && receipt.journal?.phase === crash) {
      crashed = true;
      throw new Error("Simulated stop");
    }
  };
  const text = ["Describe these", ...files].join("\n");
  const deliveryId = randomUUID();
  const post = async (url, body) => {
    const response = await f.request(url, { method: "POST", body });
    assert.equal(response.status, 200);
    return response.json();
  };
  const send = () =>
    post(inputPath, { deliveryId, deliveryScope: scope, text, submit: true });
  const recover = (mode) =>
    post(`${inputPath}/${deliveryId}/recovery`, {
      attemptId: randomUUID(),
      expectedAttemptId: deliveryId,
      deliveryScope: scope,
      text,
      mode,
    });
  const journal = () =>
    JSON.parse(fs.readFileSync(delivery.file("one", deliveryId))).journal.phase;
  const pastes = () =>
    manager.events.filter((e) => e.args[0] === "load-buffer").map((e) => e.input);
  return { f, model, manager, files, text, deliveryId, send, recover, journal, pastes };
}

test("image messages journal the image and text steps before submitting once", async (t) => {
  const x = await setup(t);
  assert.equal((await x.send()).status, "handed-off");
  assert.deepEqual(x.pastes(), [x.files.join("\n"), "Describe these"]);
  assert.deepEqual(x.model.submitted, ["[Image #1] [Image #2]Describe these"]);
  assert.equal(x.journal(), "submitted");
});

test("a stop after the images resumes with only the text, never pasting images again", async (t) => {
  const x = await setup(t, { crash: "images-pasted" });
  assert.equal((await x.send()).status, "uncertain");
  assert.equal(x.journal(), "images-pasted");
  assert.deepEqual(x.model.lines, ["[Image #1] [Image #2]"]);
  const check = await x.recover("check");
  assert.equal(check.recovery.action, "none");
  assert.equal(check.recovery.reason, copy.recoveryReadyText);
  const retry = await x.recover("retry");
  assert.equal(retry.status, "handed-off");
  assert.equal(retry.recovery.action, "completed-existing");
  assert.deepEqual(x.pastes(), [x.files.join("\n"), "Describe these"]);
  assert.deepEqual(x.model.submitted, ["[Image #1] [Image #2]Describe these"]);
  assert.equal(x.journal(), "submitted");
});

test("after the images, a different or incomplete prompt blocks recovery unchanged", async (t) => {
  const x = await setup(t, { crash: "images-pasted" });
  await x.send();
  x.model.lines = ["[Image #1]"];
  x.model.col = x.model.lines[0].length;
  const blocked = await x.recover("retry");
  assert.equal(blocked.recovery.action, "blocked");
  assert.equal(blocked.recovery.reason, copy.recoveryComposer);
  assert.deepEqual(x.pastes(), [x.files.join("\n")]);
  assert.deepEqual(x.model.submitted, []);
});

test("an interrupted text step is recovered only when the prompt proves the whole message", async (t) => {
  const x = await setup(t, { crash: "text-intent" });
  await x.send();
  assert.equal(x.journal(), "text-intent");
  // Only the images are visible: whether the text is still coming is unknown.
  const unknown = await x.recover("check");
  assert.equal(unknown.recovery.action, "blocked");
  assert.equal(unknown.recovery.reason, copy.recoveryUncertain);
  x.model.insert("Describe these");
  const check = await x.recover("check");
  assert.equal(check.recovery.reason, copy.recoveryReadySubmit);
  const retry = await x.recover("retry");
  assert.equal(retry.recovery.action, "submitted-existing");
  assert.deepEqual(x.pastes(), [x.files.join("\n")]);
  assert.deepEqual(x.model.submitted, ["[Image #1] [Image #2]Describe these"]);
});

test("a stop after the text submits the image draft without writing it again", async (t) => {
  const x = await setup(t, { crash: "pasted" });
  await x.send();
  assert.equal(x.journal(), "pasted");
  const retry = await x.recover("retry");
  assert.equal(retry.status, "handed-off");
  assert.equal(retry.recovery.action, "submitted-existing");
  assert.deepEqual(x.pastes(), [x.files.join("\n"), "Describe these"]);
  assert.deepEqual(x.model.submitted, ["[Image #1] [Image #2]Describe these"]);
});

test("intents without a proven result stay blocked", async (t) => {
  for (const crash of ["paste-intent", "submit-intent"]) {
    const x = await setup(t, { crash });
    await x.send();
    const blocked = await x.recover("retry");
    assert.equal(blocked.recovery.action, "blocked", crash);
    assert.equal(blocked.recovery.reason, copy.recoveryUncertain, crash);
    assert.deepEqual(x.model.submitted, [], crash);
  }
});

test("receipts of the former single paste still recover their chip draft", async (t) => {
  // Earlier versions pasted text and paths at once; Claude showed chips first.
  const x = await setup(t, { draft: "[Image #5] [Image #6]Describe these" });
  const delivery = x.f.application.chatDelivery;
  const generation = await withChatInput(x.manager, "one", async (tx) => tx.generation);
  for (const [phase, action] of [
    ["pasted", "submitted-existing"],
    ["paste-intent", "blocked"],
  ]) {
    const deliveryId = randomUUID();
    delivery.write(delivery.file("one", deliveryId), {
      version: 1,
      deliveryId,
      scope,
      hash: createHash("sha256")
        .update(JSON.stringify([x.text, true]))
        .digest("hex"),
      status: "uncertain",
      attemptId: deliveryId,
      journal: { phase, generation },
    });
    const response = await x.f.request(`${inputPath}/${deliveryId}/recovery`, {
      method: "POST",
      body: {
        attemptId: randomUUID(),
        expectedAttemptId: deliveryId,
        deliveryScope: scope,
        text: x.text,
        mode: "retry",
      },
    });
    assert.equal((await response.json()).recovery.action, action, phase);
  }
  assert.deepEqual(x.pastes(), []);
  assert.deepEqual(x.model.submitted, ["[Image #5] [Image #6]Describe these"]);
});
