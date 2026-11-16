import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";

const session = {
  id: "notes-session",
  accountId: "account-a",
  tool: "claude",
  createdAt: "2026-09-08T10:00:00.000Z",
  status: "running",
};
const scope = JSON.stringify([
  session.id,
  session.accountId,
  session.tool,
  session.createdAt,
]);
const NOTE_ID = randomUUID();
const OTHER_ID = randomUUID();
const NOTE_TEXT = '[AgentPier: the user stopped background task "x" (a1).]';

async function setup(t, { fail = false, events = false } = {}) {
  const f = await applicationFixture(t);
  const { sessions, requests, models, chatDelivery } = f.application;
  // A session whose CLI reports native acceptance events confirms by them.
  if (events)
    chatDelivery.acceptance = {
      supports: () => true,
      expect: () => {},
      withdraw: () => {},
      forget: () => {},
    };
  sessions.get = async () => ({ ...session });
  sessions.withChatInput = async (_id, operation) =>
    operation({
      session: { ...session },
      raw: "",
      generation: "g",
      recoveryGeneration: "g",
      composer: { state: "empty", text: null },
      write: async (_text, { onPhase }) => {
        await onPhase("paste-intent");
        if (fail) throw new Error("terminal write failed");
        await onPhase("pasted");
        await onPhase("submit-intent");
        await onPhase("submitted");
      },
    });
  requests.list = async () => ({ requests: [] });
  requests.hasPending = () => false;
  models.guardInput = async () => {};
  const consumed = [];
  const asked = [];
  chatDelivery.filterNotes = (id, ids, text) => {
    asked.push([id, ids, text]);
    return ids.filter((noteId) => noteId === NOTE_ID && text.includes(NOTE_TEXT));
  };
  chatDelivery.onNotesDelivered = (id, ids) => consumed.push([id, ids]);
  const post = (body) =>
    f.request(`/api/sessions/${session.id}/input`, { method: "POST", body });
  const message = (text, extra = {}) => ({
    deliveryId: randomUUID(),
    deliveryScope: scope,
    text,
    submit: true,
    ...extra,
  });
  return { f, post, message, consumed, asked, delivery: chatDelivery };
}

test("an accepted delivery consumes its notes once, also when replayed", async (t) => {
  const x = await setup(t);
  const body = x.message(`go on\n${NOTE_TEXT}`, { stopNoteIds: [NOTE_ID] });
  assert.equal((await (await x.post(body)).json()).status, "handed-off");
  assert.equal((await (await x.post(body)).json()).status, "handed-off");
  assert.deepEqual(x.consumed, [[session.id, [NOTE_ID]]]);
});

test("with events confirmation notes go on accept(), once", async (t) => {
  const x = await setup(t, { events: true });
  const body = x.message(`go on\n${NOTE_TEXT}`, { stopNoteIds: [NOTE_ID] });
  const sent = await (await x.post(body)).json();
  assert.equal(sent.status, "handed-off");
  assert.equal(sent.confirmation, "events");
  assert.deepEqual(x.consumed, []);
  x.delivery.accept(session.id, body.deliveryId, { kind: "accepted" });
  assert.deepEqual(x.consumed, [[session.id, [NOTE_ID]]]);
  x.delivery.accept(session.id, body.deliveryId, { kind: "accepted" });
  assert.equal(x.consumed.length, 1);
});

test("a hook-blocked delivery consumes nothing", async (t) => {
  const x = await setup(t, { events: true });
  const body = x.message(`go on\n${NOTE_TEXT}`, { stopNoteIds: [NOTE_ID] });
  assert.equal((await (await x.post(body)).json()).status, "handed-off");
  x.delivery.accept(session.id, body.deliveryId, { kind: "dropped", reason: "hook" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(x.consumed, []);
});

test("a failed receipt write leaves the notes unspent", async (t) => {
  const x = await setup(t);
  const file = x.delivery.file(session.id, randomUUID());
  fs.rmSync(x.delivery.directory, { recursive: true, force: true });
  fs.writeFileSync(x.delivery.directory, "not a folder");
  const receipt = {
    version: 1,
    deliveryId: "x",
    status: "accepted",
    stopNoteIds: [NOTE_ID],
  };
  assert.throws(() => x.delivery.write(file, receipt));
  assert.equal(receipt.notesDelivered, undefined);
  assert.deepEqual(x.consumed, []);
});

test("a failed delivery consumes nothing", async (t) => {
  const x = await setup(t, { fail: true });
  const body = x.message(`go on\n${NOTE_TEXT}`, { stopNoteIds: [NOTE_ID] });
  const result = await (await x.post(body)).json();
  assert.notEqual(result.status, "handed-off");
  assert.deepEqual(x.consumed, []);
});

test("an id whose note text is not in the message is not stored", async (t) => {
  const x = await setup(t);
  const body = x.message("no note here", { stopNoteIds: [NOTE_ID, OTHER_ID] });
  assert.equal((await (await x.post(body)).json()).status, "handed-off");
  assert.deepEqual(x.consumed, []);
});

test("slash and bang lines never carry a note", async (t) => {
  const x = await setup(t);
  for (const text of ["/compact", "!ls"]) {
    const body = x.message(`${text} ${NOTE_TEXT}`, { stopNoteIds: [NOTE_ID] });
    assert.equal((await (await x.post(body)).json()).status, "handed-off");
  }
  assert.deepEqual(x.asked, []);
  assert.deepEqual(x.consumed, []);
});

test("stopNoteIds must be at most 20 UUIDs", async (t) => {
  const x = await setup(t);
  for (const ids of ["x", ["nope"], Array.from({ length: 21 }, () => randomUUID())]) {
    const response = await x.post(x.message("hi", { stopNoteIds: ids }));
    assert.equal(response.status, 400);
  }
});
