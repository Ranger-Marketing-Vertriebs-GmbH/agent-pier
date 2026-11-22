import test from "node:test";
import assert from "node:assert/strict";
import { shortenedMark } from "../../server/features/assistants/runtimes/hermes/hermes-approval-queue.js";
import { decideExec } from "../../server/features/assistants/exec-decisions.js";
import { agentId, event, scripted, settle } from "../helpers/hermes-scripted.js";
import { fixture, request, settle as idle } from "../helpers/exec-approvals-fixture.js";

// AGENTPIER-479 review: "Always allow" remembers the digest of the command a card
// shows. A card that shows a shortened command (the guard's message over 4000
// characters, or a command over 32768) would remember the shortened text, and another
// command with the same beginning would run unasked; such a card is allow-once only.

const snapshot = () => ({
  session_id: "s1",
  stored_session_id: "s1",
  revision: 0,
  execution_generation: 1,
  subscription_id: "sub-1",
  prompts: [],
});
const asking = (id, params) =>
  event(
    "approval.request",
    "s1",
    {
      kind: "approval",
      prompt_id: id,
      execution_generation: 1,
      choices: ["once", "deny", "session"],
      timeout_s: 300,
      ...params,
    },
    { admission_id: "ad1", execution_generation: 1 },
  );

test("a request that shows a shortened command is marked partial", async () => {
  const { peer, sessions, events } = await scripted((frame) => {
    if (frame.method === "session.create") return snapshot();
    if (frame.method === "prompt.submit") return { admission_id: "ad1" };
    return {};
  });
  const { key } = await sessions.create({ agentId });
  const seen = [];
  events.subscribe((e) => seen.push(e));
  await sessions.send({ key, turn: { message: "go" }, idempotencyKey: "run-1" });
  const shortened = `${"x".repeat(4000)}${shortenedMark}`;
  peer.send(
    asking("p1", {
      command: "<browser_exec> (plugin approval rule)",
      description: shortened,
    }),
  );
  peer.send(asking("p2", { command: "y".repeat(40000), description: "long" }));
  peer.send(asking("p3", { command: "rm -rf build", description: "recursive delete" }));
  await settle();
  const requests = Object.fromEntries(
    seen
      .filter((e) => e.kind === "approval.requested")
      .map((e) => [e.payload.id, e.payload.request]),
  );
  assert.equal(requests.p1.partial, true);
  assert.equal(requests.p1.command, shortened);
  assert.equal(requests.p2.partial, true);
  assert.equal(requests.p2.command.length, 32768);
  assert.equal("partial" in requests.p3, false);
});

test("a partial request's card offers no Always allow, also not on the server", async (t) => {
  const f = fixture(t);
  const payload = request(f.agent);
  f.client.emit("exec.approval.requested", {
    ...payload,
    request: { ...payload.request, partial: true },
  });
  await idle();
  const [action] = f.w.store.list();
  assert.equal(action.payload.onceOnly, true);
  await assert.rejects(decideExec(f.w, action, "allow-always"), { status: 400 });
});
