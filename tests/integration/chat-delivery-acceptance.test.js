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

/** A fake session whose TUI write runs every phase, then `afterSubmit`. */
function setup(
  dataDir,
  { source = true, now, afterSubmit = async () => {}, afterPaste = async () => {} } = {},
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
          write: async (_text, { onPhase }) => {
            await onPhase("paste-intent");
            await onPhase("pasted");
            await afterPaste();
            await onPhase("submit-intent");
            await afterSubmit();
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
