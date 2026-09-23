import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { composerProblem } from "../../server/features/sessions/claude-composer.js";

const session = {
  id: "composer-session",
  accountId: "account-a",
  tool: "claude",
  createdAt: "2026-09-22T10:00:00.000Z",
  status: "running",
};
const scope = JSON.stringify([
  session.id,
  session.accountId,
  session.tool,
  session.createdAt,
]);
const inputPath = `/api/sessions/${session.id}/input`;

async function setup(t, write) {
  const f = await applicationFixture(t);
  const state = { composer: { state: "empty", text: null }, writes: [] };
  f.application.sessions.get = async () => ({ ...session });
  f.application.sessions.withChatInput = async (_id, operation) =>
    operation({
      session: { ...session },
      raw: "",
      generation: "fixture-runtime",
      recoveryGeneration: "fixture-runtime",
      observationGeneration: "fixture-runtime",
      get composer() {
        return state.composer;
      },
      write: (text, options) => write(text, options, state),
    });
  f.application.requests.list = async () => ({ requests: [] });
  f.application.requests.hasPending = () => false;
  f.application.models.guardInput = async () => {};
  const body = (text = "private prompt") => ({
    deliveryId: randomUUID(),
    deliveryScope: scope,
    text,
    submit: true,
  });
  const post = async (value) => {
    const response = await f.request(inputPath, { method: "POST", body: value });
    assert.equal(response.status, 200);
    return response.json();
  };
  const recover = async (input, mode = "check") => {
    const response = await f.request(`${inputPath}/${input.deliveryId}/recovery`, {
      method: "POST",
      body: {
        attemptId: randomUUID(),
        expectedAttemptId: input.deliveryId,
        deliveryScope: scope,
        text: input.text,
        mode,
      },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const journal = (input) =>
    JSON.parse(
      fs.readFileSync(f.application.chatDelivery.file(session.id, input.deliveryId)),
    ).journal.phase;
  return { f, state, body, post, recover, journal };
}

test("a dialog refused after the durable paste intent stays rejected and recoverable", async (t) => {
  const x = await setup(t, async (text, { onPhase, onRefused }) => {
    await onPhase("paste-intent");
    await onRefused("paste-intent");
    throw composerProblem("CHAT_COMPOSER_DIALOG");
  });
  const input = x.body();
  const result = await x.post(input);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "CHAT_COMPOSER_DIALOG");
  assert.match(result.error, /Dialog/);
  assert.equal(x.journal(input), "reserved");
  const replay = await (
    await x.f.request(
      `${inputPath}/${input.deliveryId}?scope=${encodeURIComponent(scope)}`,
    )
  ).json();
  assert.equal(replay.reason, "CHAT_COMPOSER_DIALOG");
  // Recovery is not blocked by a phantom paste intent.
  const check = await x.recover(input);
  assert.equal(check.recovery.action, "none");
});

test("a refused submit intent keeps the proven pasted phase for submit-only recovery", async (t) => {
  const x = await setup(t, async (text, { submitOnly, onPhase, onRefused }, state) => {
    if (submitOnly) {
      await onPhase("submit-intent");
      state.writes.push("enter");
      await onPhase("submitted");
      state.composer = { state: "empty", text: null };
      return;
    }
    await onPhase("paste-intent");
    state.writes.push("paste");
    state.composer = { state: "text", text };
    await onPhase("pasted");
    await onPhase("submit-intent");
    await onRefused("submit-intent");
    throw composerProblem("CHAT_COMPOSER_DIALOG");
  });
  const input = x.body();
  const result = await x.post(input);
  assert.equal(result.status, "uncertain");
  assert.equal(result.reason, "CHAT_COMPOSER_DIALOG");
  // The text sits in Claude's prompt: never claim it was not sent.
  assert.match(result.error, /eingefügt, aber nicht abgeschickt/);
  assert.equal(x.journal(input), "pasted");
  const retry = await x.recover(input, "retry");
  assert.equal(retry.status, "handed-off");
  assert.equal(retry.recovery.action, "submitted-existing");
  assert.deepEqual(x.state.writes, ["paste", "enter"]);
});

test("an unconfirmed Claude submit is uncertain with a stable reason", async (t) => {
  const x = await setup(t, async (text, { onPhase }) => {
    for (const phase of ["paste-intent", "pasted", "submit-intent", "submitted"])
      await onPhase(phase);
    throw composerProblem("CHAT_SUBMIT_UNCONFIRMED");
  });
  const result = await x.post(x.body());
  assert.equal(result.status, "uncertain");
  assert.equal(result.reason, "CHAT_SUBMIT_UNCONFIRMED");
  // Unknown internal errors never leak a code or their message.
  const y = await setup(t, async () => {
    throw Object.assign(new Error("secret-token"), { code: "EPIPE" });
  });
  const hidden = await y.post(y.body());
  assert.equal(hidden.status, "rejected");
  assert.equal(hidden.reason, undefined);
  assert.ok(!JSON.stringify(hidden).includes("secret-token"));
});

test("unconfirmed image chips leave a pasted, unsubmitted delivery with a stable reason", async (t) => {
  const x = await setup(t, async (text, { onPhase }) => {
    await onPhase("paste-intent");
    await onPhase("pasted");
    throw composerProblem("CHAT_IMAGES_UNCONFIRMED");
  });
  const input = x.body();
  const result = await x.post(input);
  assert.equal(result.status, "uncertain");
  assert.equal(result.reason, "CHAT_IMAGES_UNCONFIRMED");
  assert.match(result.error, /eingefügt, aber nicht abgeschickt/);
  assert.equal(x.journal(input), "pasted");
});

test("maximum-length multi-byte chat input fits the input and recovery routes", async (t) => {
  const x = await setup(t, async (text, { onPhase }, state) => {
    await onPhase("paste-intent");
    state.writes.push(text.length);
    await onPhase("pasted");
    await onPhase("submit-intent");
    await onPhase("submitted");
  });
  // 32000 characters of three UTF-8 bytes each exceed the global 64 kB JSON limit.
  const input = x.body("東".repeat(31999) + "\n");
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 64 * 1024);
  assert.equal((await x.post(input)).status, "handed-off");
  assert.deepEqual(x.state.writes, [32000]);
  assert.equal((await x.recover(input)).status, "handed-off");
  const tooLarge = await x.f.request(inputPath, {
    method: "POST",
    body: { ...x.body(), text: "x".repeat(300 * 1024) },
  });
  assert.equal(tooLarge.status, 413);
});

test("handoff notices are durable, replayed and never block the delivery", async (t) => {
  const x = await setup(t, async (text, { onPhase, onNotice }) => {
    await onNotice("CHAT_DIALOG_CLOSED");
    await onNotice("CHAT_APPENDED_TO_DRAFT");
    // Unknown codes are never persisted or leaked.
    await onNotice("SECRET_INTERNAL");
    for (const phase of ["paste-intent", "pasted", "submit-intent", "submitted"])
      await onPhase(phase);
  });
  const input = x.body();
  const result = await x.post(input);
  assert.equal(result.status, "handed-off");
  assert.deepEqual(result.notices, ["CHAT_DIALOG_CLOSED", "CHAT_APPENDED_TO_DRAFT"]);
  const replay = await (
    await x.f.request(
      `${inputPath}/${input.deliveryId}?scope=${encodeURIComponent(scope)}`,
    )
  ).json();
  assert.deepEqual(replay.notices, result.notices);
});

async function settled(x, input) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await (
      await x.f.request(
        `${inputPath}/${input.deliveryId}?scope=${encodeURIComponent(scope)}`,
      )
    ).json();
    if (result.status !== "pending") return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("The delivery stayed pending");
}

test("a native question or menu keeps the message pending, then delivers it once", async (t) => {
  let attempts = 0;
  const x = await setup(t, async (text, { onPhase }, state) => {
    attempts++;
    if (attempts === 1) throw composerProblem("CHAT_QUESTION_OPEN");
    if (attempts === 2) throw composerProblem("CHAT_DIALOG_NOT_CLOSED");
    for (const phase of ["paste-intent", "pasted", "submit-intent", "submitted"])
      await onPhase(phase);
    state.writes.push(text);
  });
  x.f.application.chatDelivery.retryMs = 10;
  const input = x.body();
  const result = await x.post(input);
  // Not rejected: the chat shows it waiting for the dialog in the terminal.
  assert.equal(result.status, "pending");
  assert.equal(result.waiting, "dialog");
  assert.equal(x.journal(input), "reserved");
  const done = await settled(x, input);
  assert.equal(done.status, "handed-off");
  assert.equal(done.waiting, undefined);
  assert.equal(done.reason, undefined);
  assert.deepEqual(x.state.writes, [input.text]);
});

test("a pending AgentPier question holds the message and delivers it after the answer", async (t) => {
  const x = await setup(t, async (text, { onPhase }, state) => {
    for (const phase of ["paste-intent", "pasted", "submit-intent", "submitted"])
      await onPhase(phase);
    state.writes.push(text);
  });
  let pending = true;
  x.f.application.requests.list = async () => ({
    requests: pending ? [{ id: "question", kind: "question" }] : [],
  });
  x.f.application.requests.hasPending = () => pending;
  x.f.application.chatDelivery.retryMs = 10;
  const input = x.body();
  const result = await x.post(input);
  assert.equal(result.status, "pending");
  assert.equal(result.waiting, "request");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(x.state.writes, []);
  // The question is answered in the chat.
  pending = false;
  const done = await settled(x, input);
  assert.equal(done.status, "handed-off");
  assert.deepEqual(x.state.writes, [input.text]);
});

test("a question that opens after the paste holds only the Enter", async (t) => {
  let pending = false;
  const x = await setup(t, async (text, { submitOnly, onPhase }, state) => {
    if (submitOnly) {
      await onPhase("submit-intent");
      state.writes.push("enter");
      await onPhase("submitted");
      return;
    }
    await onPhase("paste-intent");
    state.writes.push("paste");
    await onPhase("pasted");
    pending = true;
    await onPhase("submit-intent");
  });
  x.f.application.requests.list = async () => ({ requests: [] });
  x.f.application.requests.hasPending = () => pending;
  x.f.application.chatDelivery.retryMs = 10;
  const input = x.body();
  const result = await x.post(input);
  assert.equal(result.status, "pending");
  assert.equal(x.journal(input), "pasted");
  pending = false;
  const done = await settled(x, input);
  assert.equal(done.status, "handed-off");
  // Never pasted twice.
  assert.deepEqual(x.state.writes, ["paste", "enter"]);
});

test("a message still waiting when the server stops is uncertain and resendable", async (t) => {
  const x = await setup(t, async () => {
    throw composerProblem("CHAT_QUESTION_OPEN");
  });
  x.f.application.chatDelivery.retryMs = 60000;
  const input = x.body();
  assert.equal((await x.post(input)).status, "pending");
  // Simulate a restart: the in-memory waiter is gone.
  x.f.application.chatDelivery.active.clear();
  const replay = await (
    await x.f.request(
      `${inputPath}/${input.deliveryId}?scope=${encodeURIComponent(scope)}`,
    )
  ).json();
  assert.equal(replay.status, "uncertain");
  assert.equal(replay.reason, "CHAT_QUESTION_OPEN");
  assert.match(replay.error, /noch nicht eingegeben/);
  assert.equal((await x.recover(input)).recovery.action, "none");
});
