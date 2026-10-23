import test from "node:test";
import assert from "node:assert/strict";
import { ask, lead } from "../helpers/lead-request-service-fixture.js";

test("delivery waits for the target chat named by deliveryTarget", async (t) => {
  const f = await lead(t);
  f.service.requests.waitMs = 0;
  await ask(f, f.temporary, f.turn());
  const r = f.requests()[0];
  const other = f.store.saveConversation({
    assistantId: f.parent.id,
    runtimeSessionKey: `other-${f.parent.id}`,
  });
  const clientRequestId = `target-test:${r.id}`;
  f.service.requests.deliveryTarget = () => ({
    conversationId: other.id,
    clientRequestId,
    text: "Hello from the target",
    context: { kind: "member-result", requestId: r.id },
  });
  f.complete(r.attemptId);
  // The lead's own chat is idle, the target chat is busy: nothing is sent.
  const busy = f.assistants.ledger.accept(other.id, {
    clientRequestId: crypto.randomUUID(),
    text: "Busy",
  });
  f.assistants.ledger.recordAttempt(busy.id);
  f.idle();
  await f.service.reconcile();
  const delivered = () =>
    f.assistants.ledger
      .requests(other.id)
      .filter((x) => x.clientRequestId === clientRequestId);
  assert.equal(delivered().length, 0);
  // Once the target chat is idle the follow-up goes there, exactly once.
  for (const a of f.assistants.ledger.pending())
    f.assistants.ledger.transition(a.id, "completed");
  await f.service.reconcile();
  await f.service.reconcile();
  assert.equal(delivered().length, 1);
  assert.equal(
    f.assistants.ledger
      .requests(f.chat.id)
      .filter((x) => x.clientRequestId === clientRequestId).length,
    0,
  );
});
