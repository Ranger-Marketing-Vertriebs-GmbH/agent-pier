import { lead } from "./lead-request-service-fixture.js";
import { createPeerRequest } from "../../server/features/assistants/peer-request-rules.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

// The fixture lead with one temporary and one permanent member plus a second
// permanent one (`count` adds further permanent members for the caps).
export async function peers(t, { count = 3 } = {}) {
  const f = await lead(t, { count });
  for (const m of f.members.slice(2))
    await f.service.lifecycle("promote", m.id, f.service.store.member(m.id).revision);
  const fresh = (m) => f.service.store.member(m.id);
  const [temporary, permanent, second, ...more] = f.members.map(fresh);
  // A turn in the member's own chat with this trusted context.
  const memberTurn = (member, context = { kind: "owner" }) => {
    const request = f.assistants.ledger.accept(fresh(member).conversationId, {
      clientRequestId: crypto.randomUUID(),
      text: "Work",
    });
    f.service.store.recordContext(request.id, context);
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    return { attemptId: attempt.id, toolCallId: crypto.randomUUID(), assertCurrent() {} };
  };
  const peerAsk = (inv, target, extra = {}, now) =>
    createPeerRequest(f.service, {
      type: "question",
      inv,
      input: { memberId: target.id, question: "What did you find?", ...extra },
      now,
    });
  const peerDelegate = (inv, target, extra = {}, now) =>
    createPeerRequest(f.service, {
      type: "task",
      inv,
      input: { memberId: target.id, task: "Check the numbers", ...extra },
      now,
    });
  // The tool error code a call fails with, or null when it succeeds.
  const code = (call) => {
    try {
      call();
      return null;
    } catch (error) {
      return toolError(error).code;
    }
  };
  // Ends a request so it no longer counts as open.
  const finish = (r) =>
    f.service.store.write(f.service.requests.store.get(r.id), { phase: "completed" });
  // Archives an agent in place, as its archive would.
  const archive = (assistantId) => {
    const a = f.store.getAssistant(assistantId);
    f.store.db
      .prepare("UPDATE assistants SET body=? WHERE id=?")
      .run(JSON.stringify({ ...a, archivedAt: new Date().toISOString() }), a.id);
  };
  // Ends every open turn, so the next lead request reaches its member.
  const settle = () => {
    for (const a of f.assistants.ledger.pending())
      f.assistants.ledger.transition(a.id, "completed");
  };
  return {
    ...f,
    archive,
    settle,
    temporary,
    permanent,
    second,
    more,
    fresh,
    memberTurn,
    peerAsk,
    peerDelegate,
    code,
    finish,
  };
}
