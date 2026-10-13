import test from "node:test";
import assert from "node:assert/strict";
import { ask, lead, until, writeGate } from "../helpers/lead-request-service-fixture.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { askWaitMs } from "../../server/features/assistants/lead-requests.js";
import {
  followUp,
  followUpMaxChars,
} from "../../server/features/assistants/lead-request-text.js";

test("an owner-requested task writes in the member's workspace, never its memory", async (t) => {
  const f = await writeGate(t);
  const lead1 = f.turn();
  const { requestId } = await f.delegate(lead1);
  assert.equal(f.service.requests.store.get(requestId).phase, "running");
  assert.equal(f.write(), true);
  for (const path of ["memory/today.md", "MEMORY.md", "Memory/x.md"])
    assert.equal(f.write(path), false, path);
  // The same member's lead-owned run is the only one: a forged agent id is refused.
  assert.equal(f.write("notes/plan.md", f.store.getAssistant(f.parent.id)), false);
  // Cancelled: the grant ends at once, before the runtime confirms.
  await f.service.cancel(lead1, { requestId });
  assert.equal(f.write(), false);
});

test("questions, agent-initiated tasks and revoked grants never write", async (t) => {
  const f = await writeGate(t);
  f.service.requests.waitMs = 0;
  await ask(f, f.permanent, f.turn());
  assert.equal(f.service.requests.store.list()[0].phase, "running");
  assert.equal(f.write(), false, "a question never writes");
  f.complete(f.service.requests.store.list()[0].attemptId);
  f.idle();
  await f.service.reconcile();
  // Agent-initiated, even with a quote: runs at once, read-only.
  const agentTurn = f.turn("Summarize the results", { kind: "team-result" });
  const agent = await f.delegate(agentTurn);
  assert.equal(agent.status, "delegated");
  assert.equal(agent.mayWrite, false);
  assert.equal(f.service.requests.store.get(agent.requestId).phase, "running");
  assert.equal(f.write(), false, "an agent-initiated task never writes");
  f.complete(f.service.requests.store.get(agent.requestId).attemptId);
  f.idle();
  await f.service.reconcile();
  // The owner's own words: the same member's next task writes...
  const proven = await f.delegate(f.turn());
  assert.equal(proven.mayWrite, true);
  assert.equal(f.write(), true);
  // ...but not without its stored grant or its proof.
  const running = f.service.requests.store.get(proven.requestId);
  f.service.store.write(running, { writeAllowed: false });
  assert.equal(f.write(), false);
  f.service.store.write(f.service.requests.store.get(running.id), {
    writeAllowed: true,
    ownerProof: null,
  });
  assert.equal(f.write(), false);
  // Positive control: the lead's own owner turn writes as before.
  f.idle();
  f.turn();
  assert.equal(f.write("notes.md", f.store.getAssistant(f.parent.id), f.chat), true);
});

test("a wait never outlives the caller: a late answer becomes a follow-up", async (t) => {
  const f = await lead(t);
  const inv = { ...f.turn(), startedAt: Date.now() - askWaitMs - 1 };
  const result = await ask(f, f.temporary, inv);
  assert.equal(result.status, "asked");
  const r = f.service.requests.store.list()[0];
  f.complete(r.attemptId);
  f.idle();
  await f.service.reconcile();
  const stored = f.service.requests.store.get(r.id);
  assert.equal(stored.delivery, "sent");
});

test("an inline answer the caller never received is handed back as a follow-up", async (t) => {
  const f = await lead(t);
  const inv = f.turn();
  const pending = ask(f, f.temporary, inv);
  const r = await until(() =>
    f.service.requests.store.list().find((x) => x.phase === "running"),
  );
  f.complete(r.attemptId);
  await f.service.reconcile();
  assert.equal((await pending).status, "answered");
  assert.equal(typeof inv.undelivered, "function");
  inv.undelivered();
  f.idle();
  await f.service.reconcile();
  assert.equal(f.service.requests.store.get(r.id).delivery, "sent");
});

test("the bridge hands an answer back when the caller is gone", async (t) => {
  const f = await lead(t);
  let handedBack = 0;
  const bridge = new TeamBridge({
    assistants: f.assistants,
    teams: {
      async ask(inv) {
        inv.undelivered = () => handedBack++;
        await new Promise((r) => setTimeout(r, 300));
        return { status: "answered" };
      },
    },
  });
  const { url, token } = await bridge.start();
  t.after(() => bridge.close());
  f.turn();
  const post = (endpoint, body, signal) =>
    fetch(url + endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  const ticket = await (
    await post("/prepare", {
      agentId: f.store.getAssistant(f.parent.id).runtimeAgentId,
      sessionKey: f.chat.runtimeSessionKey,
      toolCallId: "late",
      action: "ask",
    })
  ).json();
  assert.ok(ticket.ticket, "positive control: the lead's own turn prepares");
  await assert.rejects(
    post(
      "/invoke",
      { ticket: ticket.ticket, action: "ask", input: {} },
      AbortSignal.timeout(50),
    ),
  );
  await until(() => handedBack > 0, "hand-back");
  assert.equal(handedBack, 1);
});

test("follow-ups stay inside the frame limit and end visibly when they cannot go out", async (t) => {
  const text = followUp({
    type: "task",
    memberName: "Scout",
    phase: "completed",
    text: '"\u0001'.repeat(4096),
    answer: '\\"'.repeat(3000),
  });
  assert.ok(text.length <= followUpMaxChars, String(text.length));
  assert.match(text, /"shortened":true/);
  JSON.parse(text.slice(text.indexOf("\n{") + 1));

  const f = await lead(t);
  f.service.requests.waitMs = 0;
  const send = f.assistants.send.bind(f.assistants);
  let refuse = 503,
    tries = 0;
  f.assistants.send = (id, input, context) => {
    if (!input.clientRequestId.startsWith("lead-request-result:"))
      return send(id, input, context);
    tries++;
    return Promise.reject(Object.assign(Error("refused"), { status: refuse }));
  };
  await ask(f, f.temporary, f.turn());
  const r = f.service.requests.store.list()[0];
  f.complete(r.attemptId);
  f.idle();
  await f.service.reconcile();
  const waiting = f.service.requests.store.get(r.id);
  assert.equal(tries, 1);
  assert.equal(waiting.delivery, "pending");
  assert.ok(waiting.deliveryRetryAt > Date.now(), "backs off");
  await f.service.reconcile();
  assert.equal(tries, 1, "no retry before the backoff ends");
  assert.equal(
    f.service.requests.store.get(r.id).revision,
    waiting.revision,
    "no rewrite",
  );
  // A refusal that cannot pass ends the delivery, visible on the request.
  refuse = 400;
  f.service.store.write(f.service.requests.store.get(r.id), { deliveryRetryAt: 0 });
  await f.service.reconcile();
  const failed = f.service.requests.store.get(r.id);
  assert.equal(failed.delivery, "failed");
  assert.equal(failed.resultDiagnostic, "FOLLOW_UP_FAILED");
  assert.ok(!f.service.requests.store.pending().some((x) => x.id === r.id), "settled");
  await f.service.reconcile();
  assert.equal(tries, 2);
});

test("the browser list carries summaries; details load on demand", async (t) => {
  const f = await lead(t);
  f.service.requests.waitMs = 0;
  await f.service.ask(f.turn(), {
    memberId: f.temporary.id,
    question: `${"Long question. ".repeat(40)}End?`,
  });
  const r = f.service.requests.store.list()[0];
  f.complete(r.attemptId);
  await f.service.reconcile();
  const [summary] = f.service.list().requests;
  assert.equal(summary.truncated, true);
  assert.ok(summary.text.length <= 300);
  assert.equal(summary.answer, undefined);
  assert.equal(summary.hasAnswer, true);
  const detail = f.service.requestDetail(r.id);
  assert.ok(detail.text.endsWith("End?"));
  assert.equal(detail.answer, "Result from member");
});

test("a lead cannot cancel another lead's request", async (t) => {
  const f = await lead(t);
  f.service.requests.waitMs = 0;
  await ask(f, f.temporary, f.turn());
  const r = f.service.requests.store.list()[0];
  const other = await f.proposal({ count: 1 });
  f.assistants.ledger.transition(other.attempt.id, "completed");
  const request = f.assistants.ledger.accept(other.chat.id, {
    clientRequestId: "other",
    text: "Cancel everything",
  });
  f.service.store.recordContext(request.id, { kind: "owner" });
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  await assert.rejects(
    f.service.cancel(
      { attemptId: attempt.id, toolCallId: "x", assertCurrent() {} },
      { requestId: r.id },
    ),
    { status: 404 },
  );
  assert.equal(f.service.requests.store.get(r.id).cancelRequested, undefined);
});
