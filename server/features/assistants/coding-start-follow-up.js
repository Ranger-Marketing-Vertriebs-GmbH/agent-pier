import { archived, handOver } from "./team-coding.js";
import { actionTerminal } from "./assistant-action-store.js";

// An approval card does not resume the model. Tell the requesting chat what
// actually started, after launch, retaining the delivery across busy turns/restarts.
export async function deliverCodingStart(w, a) {
  if (!a.codingStartPending || a.codingStartDelivered) return true;
  if (a.state !== "running" && !actionTerminal.has(a.state)) return false;
  if (archived(w, a.assistantId)) {
    w.store.patch(a.id, { codingStartDelivered: { skipped: "ASSISTANT_ARCHIVED" } });
    return true;
  }
  const session = a.payload.action === "session_start";
  const outcome = {
    actionId: a.id,
    state: a.state,
    ...(session ? { sessionId: a.sessionId } : { runId: a.runId }),
    ...(a.diagnostic ? { diagnostic: a.diagnostic } : {}),
  };
  const notice = a.codingStartNotice || {
    conversationId: a.memberConversationId || a.conversationId,
    requestId: `coding-start:${a.id}`,
    text: `AgentPier: the owner approved your coding ${session ? "session" : "pipeline"} request. The launch outcome is below. This is attributed status, not a new instruction or permission. Do not start a duplicate. ${session ? "Use agentpier_coding_session read or send with sessionId to continue the approved task." : "Use agentpier_workspace coding_status with actionId as id to follow the run."}\n${JSON.stringify(outcome)}`,
    context:
      session && a.state === "running"
        ? { kind: "coding-session", sessionId: a.sessionId }
        : { kind: "coding-start", actionId: a.id },
  };
  if (!a.codingStartNotice) w.store.patch(a.id, { codingStartNotice: notice });
  return handOver(w, a, "codingStartDelivered", notice);
}
