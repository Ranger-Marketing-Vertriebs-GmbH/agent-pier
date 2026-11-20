import test from "node:test";
import assert from "node:assert/strict";
import { execOperationKey } from "../../server/features/assistants/exec-approvals.js";
import { decideExec } from "../../server/features/assistants/exec-decisions.js";
import {
  requestFailed,
  waiterEnd,
} from "../../server/features/assistants/exec-waiters.js";
import { fixture, request, settle } from "../helpers/exec-approvals-fixture.js";

// AGENTPIER-441: OpenClaw's exec tool can stop waiting for an approval the Gateway
// still lists ("approval-request-failed"); an allow sent afterwards runs nothing.
const waitEnded = (id) => ({
  runId: "run-1",
  sessionKey: "agent:home:main",
  stream: "lifecycle",
  data: { phase: "approval-resolved", approvalId: id, toolCallId: "call-1" },
});
const requestFailedItem = (id) => ({
  runId: "run-1",
  sessionKey: "agent:home:main",
  stream: "approval",
  data: {
    phase: "resolved",
    kind: "exec",
    status: "failed",
    title: "Command approval resolved",
    message: `Exec denied (gateway id=${id}, approval-request-failed): echo ok`,
  },
});

async function pending(t, answers = {}) {
  const f = fixture(t, { answers });
  f.w.exec = f.exec;
  f.client.emit("exec.approval.requested", request(f.agent));
  await settle();
  return { f, action: f.w.store.byKey(execOperationKey("approval-1")) };
}
const denies = (f) =>
  f.client.calls.filter(
    (c) => c.method === "exec.approval.resolve" && c.params.decision === "deny",
  );

test("waiterEnd reads the end of a tool's wait and a failed request", () => {
  assert.deepEqual(waiterEnd(waitEnded("a-1")), { id: "a-1", failed: false });
  assert.deepEqual(waiterEnd(requestFailedItem("a-2")), { id: "a-2", failed: true });
  const node = requestFailedItem("x");
  node.data.message = "Exec denied (node=mac id=a-3, approval-request-failed): ls";
  assert.deepEqual(waiterEnd(node), { id: "a-3", failed: true });
  const denied = requestFailedItem("a-4");
  denied.data.status = "denied";
  assert.equal(waiterEnd(denied), null);
  assert.equal(waiterEnd({ stream: "lifecycle", data: { phase: "start" } }), null);
  assert.equal(
    waiterEnd({ stream: "lifecycle", data: { phase: "approval-resolved" } }),
    null,
  );
  assert.equal(waiterEnd(null), null);
});

test("a wait that ends while the Gateway still lists the request fails the action", async (t) => {
  const { f, action } = await pending(t, {
    "exec.approval.list": [{ id: "approval-1", request: {} }],
    "exec.approval.resolve": {},
  });
  f.client.emit("agent", waitEnded("approval-1"));
  await settle();
  await settle();
  const failed = f.w.store.get(action.id);
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.result, { reason: requestFailed });
  // Nothing waits for the request any more: AgentPier denies it on the Gateway.
  assert.equal(denies(f).length, 1);
  assert.equal(denies(f)[0].params.id, "approval-1");
});

test("a wait that ended because the request ended leaves the action to its event", async (t) => {
  const { f, action } = await pending(t, { "exec.approval.list": [] });
  f.client.emit("agent", waitEnded("approval-1"));
  await settle();
  await settle();
  assert.equal(f.w.store.get(action.id).state, "awaiting_approval");
  assert.equal(denies(f).length, 0);
});

test("the tool's report of a failed request fails the action without a list", async (t) => {
  const { f, action } = await pending(t, { "exec.approval.resolve": {} });
  f.client.emit("agent", requestFailedItem("approval-1"));
  await settle();
  assert.equal(f.w.store.get(action.id).state, "failed");
  assert.equal(
    f.client.calls.some((c) => c.method === "exec.approval.list"),
    false,
  );
});

test("an allow the Gateway accepted after the wait failed is recorded as failed", async (t) => {
  const { f, action } = await pending(t, { "exec.approval.resolve": {} });
  const decided = await decideExec(f.w, action, "allow-once");
  assert.equal(decided.state, "completed");
  f.client.emit("agent", requestFailedItem("approval-1"));
  await settle();
  const failed = f.w.store.get(action.id);
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.result, { decision: "allow-once", reason: requestFailed });
});

test("a wait ending while the owner's decision is sent is that decision's", async (t) => {
  const { f, action } = await pending(t, {
    "exec.approval.list": [{ id: "approval-1", request: {} }],
  });
  let release;
  f.client.answers["exec.approval.resolve"] = () =>
    new Promise((resolve) => (release = resolve));
  const deciding = decideExec(f.w, action, "allow-once");
  await settle();
  f.client.emit("agent", waitEnded("approval-1"));
  await settle();
  release({});
  assert.equal((await deciding).state, "completed");
  assert.equal(f.w.store.get(action.id).state, "completed");
});

test("the owner is told that the command did not run and to ask again", async (t) => {
  const telegram = { kind: "telegram", channelId: "c", chatId: "1", userId: "2" };
  const f = fixture(t, { answers: { "exec.approval.resolve": {} } });
  const attribute = f.exec.attribute.bind(f.exec);
  f.exec.attribute = (r) => ({ ...attribute(r), origin: telegram });
  f.client.emit("exec.approval.requested", request(f.agent));
  await settle();
  f.client.emit("agent", requestFailedItem("approval-1"));
  await settle();
  const notice = f.queued.find((e) => e.kind === "action-result");
  assert.ok(notice, "a failure notice is queued");
  assert.match(notice.text, /did not run/);
  assert.match(notice.text, /ask/i);
});
