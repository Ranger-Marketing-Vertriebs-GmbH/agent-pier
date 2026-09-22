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
