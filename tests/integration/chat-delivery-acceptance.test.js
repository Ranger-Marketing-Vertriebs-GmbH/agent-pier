import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ChatDelivery } from "../../server/features/chat/chat-delivery.js";
import { DeliveryAcceptance } from "../../server/features/chat/delivery-acceptance.js";
import { createChatDelivery } from "../../server/application/chat-delivery-wiring.js";

const session = { id: "one", accountId: "fixture", tool: "claude", createdAt: "x" };
const scope = JSON.stringify(["one", "fixture", "claude", "x"]);

function tempDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-acceptance-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

/**
 * A fake session whose TUI write runs every phase. `afterSubmit` gets the write
 * options, so it can refuse Enter like the composer guard does.
 */
function setup(
  dataDir,
  {
    source = true,
    now,
    afterSubmit = async () => {},
    afterPaste = async () => {},
    composer = { state: "text", text: "hello" },
  } = {},
) {
  const changes = [];
  let delivery;
  const acceptance = new DeliveryAcceptance({
    ...(now ? { now } : {}),
    onMatch: (id, deliveryId, outcome) => delivery.accept(id, deliveryId, outcome),
  });
  if (source) acceptance.ready(session.id, {});
  delivery = new ChatDelivery({
    dataDir,
    acceptance,
    sessions: {
      get: async () => session,
      withChatInput: (_id, operation) =>
        operation({
          session,
          raw: "",
          composer: { state: "text", text: "hello" },
          recoveryGeneration: "fixture",
          observationGeneration: "fixture",
          screen: async () => ({ raw: "", pane: {}, composer }),
          write: async (_text, options) => {
            const { onPhase } = options;
            await onPhase("paste-intent");
            await onPhase("pasted");
            await afterPaste();
            await onPhase("submit-intent");
            await afterSubmit(options);
            await onPhase("submitted");
          },
        }),
    },
    requests: {
      list: async () => ({ requests: [] }),
      hasPending: () => false,
      clearNotice: () => {},
    },
    models: { guardInput: async () => {} },
    retryMs: 10,
    onChange: (id) => changes.push(id),
  });
  const send = (text = "hello", deliveryId = randomUUID()) =>
    delivery.send(session.id, { deliveryId, deliveryScope: scope, text, submit: true });
  const status = (deliveryId) => delivery.status(session.id, deliveryId, scope);
  const event = (fields = {}) =>
    acceptance.report(session.id, {
      kind: "accepted",
      at: Date.now(),
      imageNames: null,
      imageCount: 0,
      ...fields,
    });
  return { delivery, acceptance, changes, send, status, event };
}

test("accepted event turns handed-off into accepted and publishes", async (t) => {
  const x = setup(tempDir(t));
  const sent = await x.send();
  assert.equal(sent.status, "handed-off");
  assert.equal(sent.confirmation, "events");
  assert.equal(typeof sent.submittedAt, "number");
  const before = x.changes.length;
  x.event({ queued: true });
  const accepted = await x.status(sent.deliveryId);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.queued, true);
  assert.equal(typeof accepted.acceptedAt, "number");
  assert.equal(accepted.error, undefined);
  assert.equal(x.changes.length, before + 1);
  assert.equal(x.changes.at(-1), session.id);
});

test("an event while the delivery still runs is not overwritten by handed-off", async (t) => {
  let x;
  x = setup(tempDir(t), { afterSubmit: async () => x.event() });
  const sent = await x.send();
  assert.equal(sent.status, "accepted");
  assert.equal((await x.status(sent.deliveryId)).status, "accepted");
});

test("image names and count must fit the delivered images", async (t) => {
  const dataDir = tempDir(t);
  const image = path.join(dataDir, "shot.png");
  fs.writeFileSync(image, "png");
  const x = setup(dataDir);
  const sent = await x.send(`${image}\nlook`);
  // An owner prompt without the image is not this delivery.
  x.event({ imageCount: 0 });
  assert.equal((await x.status(sent.deliveryId)).status, "handed-off");
  x.event({ imageCount: 1, imageNames: ["shot.png"] });
  assert.equal((await x.status(sent.deliveryId)).status, "accepted");
});

test("uncertain receipt is confirmed by a later event", async (t) => {
  const x = setup(tempDir(t), {
    afterSubmit: async () => {
      throw new Error("Enter not proven");
    },
  });
  const sent = await x.send();
  assert.equal(sent.status, "uncertain");
  x.event();
  const accepted = await x.status(sent.deliveryId);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.reason, undefined);
});

// The composer guard refuses Enter after the submit intent was journaled.
const refuseEnter = async (options, code) => {
  await options.onRefused("submit-intent");
  throw Object.assign(new Error("Enter refused"), code ? { code } : {});
};

test("refused Enter, then owner prompt: receipt stays uncertain", async (t) => {
  const x = setup(tempDir(t), { afterSubmit: (options) => refuseEnter(options) });
  const sent = await x.send();
  assert.equal(sent.status, "uncertain");
  // The owner's own prompt in the TUI is no confirmation of this message.
  x.event();
  assert.equal((await x.status(sent.deliveryId)).status, "uncertain");
});

test("held then retried A, then B's event confirms B", async (t) => {
  let refused = false;
  const x = setup(tempDir(t), {
    afterSubmit: async (options) => {
      if (refused) return;
      refused = true;
      await refuseEnter(options, "CHAT_QUESTION_OPEN");
    },
  });
  const a = await x.send("first");
  assert.equal(a.status, "pending");
  let current = a;
  for (let n = 0; n < 200 && current.status === "pending"; n++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = await x.status(a.deliveryId);
  }
  assert.equal(current.status, "handed-off");
  x.event();
  assert.equal((await x.status(a.deliveryId)).status, "accepted");
  const b = await x.send("second");
  assert.equal(b.status, "handed-off");
  x.event();
  assert.equal((await x.status(b.deliveryId)).status, "accepted");
});

test("a delivery without an event is not confirmed by the next one's event", async (t) => {
  const x = setup(tempDir(t));
  // D1 never produces an event (a hook-blocked steer, a command with no submit event).
  const d1 = await x.send("first");
  assert.equal(d1.status, "handed-off");
  const d2 = await x.send("second");
  assert.equal(d2.status, "handed-off");
  x.event();
  assert.equal((await x.status(d2.deliveryId)).status, "accepted");
  assert.equal((await x.status(d1.deliveryId)).status, "handed-off");
  // D1 is retired: a later event does not confirm it either.
  x.event();
  assert.equal((await x.status(d1.deliveryId)).status, "handed-off");
});

test("late event after ask timeout still confirms", async (t) => {
  let clock = Date.now();
  const x = setup(tempDir(t), { now: () => clock });
  const sent = await x.send();
  clock += 60_000;
  x.event({ at: sent.submittedAt + 60_000 });
  assert.equal((await x.status(sent.deliveryId)).status, "accepted");
});

test("accepted is terminal", async (t) => {
  const x = setup(tempDir(t));
  const sent = await x.send();
  x.event({ queued: false });
  const first = await x.status(sent.deliveryId);
  const changes = x.changes.length;
  x.delivery.accept(session.id, sent.deliveryId, { kind: "accepted", queued: true });
  const second = await x.status(sent.deliveryId);
  assert.equal(second.status, "accepted");
  assert.equal(second.queued, false);
  assert.equal(second.acceptedAt, first.acceptedAt);
  assert.equal(x.changes.length, changes);
});

test("expectations do not survive a restart", async (t) => {
  const dataDir = tempDir(t);
  const sent = await setup(dataDir).send();
  const restarted = setup(dataDir);
  restarted.event();
  assert.equal((await restarted.status(sent.deliveryId)).status, "handed-off");
});

test("session without a source keeps confirmation text", async (t) => {
  const x = setup(tempDir(t), { source: false });
  const sent = await x.send();
  assert.equal(sent.status, "handed-off");
  assert.equal(sent.confirmation, "text");
  x.event();
  assert.equal((await x.status(sent.deliveryId)).status, "handed-off");
});

test("a recovery that submits the pasted text expects the acceptance too", async (t) => {
  let paste = 0;
  const x = setup(tempDir(t), {
    afterPaste: async () => {
      if (paste++ === 0) throw new Error("Enter never sent");
    },
  });
  const sent = await x.send();
  assert.equal(sent.status, "uncertain");
  const recovered = await x.delivery.recover(session.id, sent.deliveryId, {
    attemptId: randomUUID(),
    expectedAttemptId: sent.attemptId,
    deliveryScope: scope,
    text: "hello",
    mode: "retry",
  });
  assert.equal(recovered.recovery.action, "submitted-existing");
  assert.equal(recovered.confirmation, "events");
  x.event();
  assert.equal((await x.status(sent.deliveryId)).status, "accepted");
});

test("the application wiring confirms deliveries through its own matcher", async (t) => {
  const { delivery: fake } = setup(tempDir(t));
  const delivery = createChatDelivery({
    dataDir: tempDir(t),
    sessions: fake.sessions,
    requests: fake.requests,
    models: fake.models,
  });
  delivery.acceptance.ready(session.id, {});
  const sent = await delivery.send(session.id, {
    deliveryId: randomUUID(),
    deliveryScope: scope,
    text: "hello",
    submit: true,
  });
  assert.equal(sent.confirmation, "events");
  delivery.acceptance.report(session.id, {
    kind: "accepted",
    at: Date.now(),
    imageNames: null,
    imageCount: 0,
  });
  const accepted = await delivery.status(session.id, sent.deliveryId, scope);
  assert.equal(accepted.status, "accepted");
});

test("command with empty prompt is accepted without an expectation", async (t) => {
  const x = setup(tempDir(t), { composer: { state: "empty", text: "" } });
  const sent = await x.send("/cost");
  assert.equal(sent.status, "accepted");
  assert.equal(sent.command, true);
  assert.equal(sent.confirmation, "screen");
  assert.equal((await x.status(sent.deliveryId)).status, "accepted");
});

test("command left in prompt stays handed-off", async (t) => {
  const x = setup(tempDir(t), { composer: { state: "text", text: "!ls" } });
  const sent = await x.send("!ls");
  assert.equal(sent.status, "handed-off");
  assert.equal(sent.command, true);
  x.event();
  assert.equal((await x.status(sent.deliveryId)).status, "handed-off");
});

test("ordinary text with an empty prompt is never confirmed by the screen", async (t) => {
  const x = setup(tempDir(t), { composer: { state: "empty", text: "" } });
  const sent = await x.send("hello");
  assert.equal(sent.status, "handed-off");
  assert.equal(sent.command, undefined);
});

test("settled resolves on accept and at the timeout with handed-off", async (t) => {
  const x = setup(tempDir(t));
  const sent = await x.send();
  const waiting = x.delivery.settled(session.id, sent.deliveryId);
  x.event();
  const accepted = await waiting;
  assert.equal(accepted.status, "accepted");
  assert.equal(x.delivery.waiters.size, 0);
  // Already settled: answers at once.
  assert.equal(
    (await x.delivery.settled(session.id, sent.deliveryId)).status,
    "accepted",
  );
  const second = await x.send("again");
  const open = await x.delivery.settled(session.id, second.deliveryId, { timeoutMs: 20 });
  assert.equal(open.status, "handed-off");
  assert.equal(x.delivery.waiters.size, 0);
});
