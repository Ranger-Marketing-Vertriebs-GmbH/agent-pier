import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { reconcileRuns } from "../../server/features/assistants/run-reconciler.js";
import { boundAttempts } from "../../server/features/assistants/session-bindings.js";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-race-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AssistantStore({ dataDir });
  t.after(() => store.close());
  const ledger = new RequestLedger(store.db);
  const agent = store.createAssistant({
    name: "Owner",
    instructions: "",
    model: { connectionId: "x", modelId: "x" },
  });
  const turn = (key) => {
    const c = store.saveConversation({ assistantId: agent.id, runtimeSessionKey: key });
    return ledger.recordAttempt(
      ledger.accept(c.id, { clientRequestId: key, text: key }).id,
    );
  };
  const service = (call, sending = new Set()) => ({
    closed: false,
    ledger,
    store,
    sending,
    runtime: { client: { ready: true, call } },
    history: async () => ({}),
    reviewable: () => true,
  });
  return { ledger, turn, service };
}

// A reconcile pass snapshots unresolved attempts, then awaits per attempt. A turn
// sent meanwhile is "pending" in the snapshot; its send is acknowledged while the
// pass waits on an earlier attempt; the pass then read the stale "pending" state.
test("a turn acknowledged while the pass awaits an earlier one stays live", async (t) => {
  const { ledger, turn, service } = fixture(t);
  // Turn 1: already done on the Gateway, not yet recorded by AgentPier.
  const a1 = turn("s1");
  ledger.transition(a1.id, "accepted", { runtimeRunId: a1.id });
  // Turn 2: its send is under way.
  const a2 = turn("s2");
  const sending = new Set([a2.id]);
  const svc = service(async (method, params) => {
    if (method === "agent.wait" && params.runId === a1.id) {
      // Meanwhile turn 2's send is acknowledged (conversation-turns.js).
      ledger.transition(a2.id, "accepted", { runtimeRunId: a2.id });
      sending.delete(a2.id);
      return { status: "ok", runId: a1.id };
    }
    if (method === "agent.wait") return { status: "timeout" };
    if (method === "sessions.describe") return { session: {} };
    return {};
  }, sending);
  assert.equal(boundAttempts(svc, "s2").length, 1, "turn 2 is live before the pass");
  await reconcileRuns(svc);
  assert.equal(ledger.getAttempt(a1.id).state, "completed");
  assert.equal(
    ledger.getAttempt(a2.id).state,
    "accepted",
    "the live turn stays accepted",
  );
  assert.equal(boundAttempts(svc, "s2").length, 1, "the bridge still finds turn 2");
});

// The same race inside one attempt's own Gateway calls: only the guarded update
// stands between a late acknowledgement and the demotion.
test("a turn acknowledged during its own wait is not demoted", async (t) => {
  const { ledger, turn, service } = fixture(t);
  const a = turn("s1");
  const svc = service(async (method) => {
    if (method === "agent.wait") return { status: "timeout" };
    if (method === "sessions.describe") {
      ledger.transition(a.id, "accepted", { runtimeRunId: a.id });
      return { session: {} };
    }
    return {};
  });
  await reconcileRuns(svc);
  assert.equal(ledger.getAttempt(a.id).state, "accepted");
});

test("a turn confirmed during its wait is not marked interrupted", async (t) => {
  const { ledger, turn, service } = fixture(t);
  const a = turn("s1");
  ledger.transition(a.id, "accepted", { runtimeRunId: a.id });
  const svc = service(async (method) => {
    if (method === "agent.wait") return { status: "timeout" };
    if (method === "sessions.describe") {
      ledger.transition(a.id, "running", { runtimeRunId: a.id });
      return { session: { subagentRunState: "interrupted" } };
    }
    return {};
  });
  await reconcileRuns(svc);
  assert.equal(ledger.getAttempt(a.id).state, "running");
});

test("a genuinely stale pending turn is still demoted to uncertain", async (t) => {
  const { ledger, turn, service } = fixture(t);
  const stale = turn("s1");
  const interrupted = turn("s2");
  ledger.transition(interrupted.id, "accepted", { runtimeRunId: interrupted.id });
  const svc = service(async (method, params) => {
    if (method === "agent.wait") return { status: "timeout" };
    if (method === "sessions.describe")
      return {
        session: params.key === "s2" ? { subagentRunState: "interrupted" } : {},
      };
    return {};
  });
  await reconcileRuns(svc);
  assert.equal(ledger.getAttempt(stale.id).state, "uncertain");
  assert.equal(ledger.getAttempt(interrupted.id).state, "interrupted");
});

test("a guarded transition only moves from the expected state", (t) => {
  const { ledger, turn } = fixture(t);
  const a = turn("s1");
  ledger.transition(a.id, "accepted", { runtimeRunId: a.id });
  const kept = ledger.transition(a.id, "uncertain", {}, { from: "pending" });
  assert.equal(kept.state, "accepted");
  assert.equal(ledger.getRequest(a.requestId).state, "accepted");
  const moved = ledger.transition(a.id, "running", {}, { from: "accepted" });
  assert.equal(moved.state, "running");
  assert.equal(ledger.getRequest(a.requestId).state, "running");
});
