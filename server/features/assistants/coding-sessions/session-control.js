import { assistantProblem } from "../assistant-validation.js";
import { isUserAgent } from "../../users/user-access.js";

const notFound = () => assistantProblem("notFound", 404);
const revoked = () => assistantProblem("grantRevoked", 403);

/**
 * Whether the agent may start a session on `projectId` in this turn: on its own
 * grant (project and its coding sessions switch), or else through a standing share
 * of its lead that covers coding on the project while the lead itself has sessions
 * on for it (`inherited`; such starts always wait for the owner). A lead's follow-up
 * on its member's result and a temporary member's team turn use the agent's own
 * grant only. Throws SESSIONS_NOT_ENABLED otherwise.
 */
export function sessionGrant(w, ctx, projectId) {
  if (w.access.sessionsEnabled(ctx.assistantId, projectId)) return { inherited: null };
  if (!ctx.requestedBy && !ctx.memberResult) {
    const share = w.shares.coding(ctx.assistantId, projectId, {});
    if (share && !share.requestId && w.access.sessionsEnabled(share.leadId, projectId)) {
      w.access.eligible(ctx.assistantId);
      return { inherited: { leadId: share.leadId, shareId: share.shareId } };
    }
  }
  throw assistantProblem("sessionsNotEnabled", 403);
}

/** Whether a record's grant still holds right now. Never throws. */
export function stillGranted(w, record) {
  try {
    const agent = w.access.eligible(record.assistantId);
    if (isUserAgent(agent)) return false;
    if (!record.inherited) return w.access.sessionsEnabled(agent.id, record.projectId);
    const row = w.shares.find(record.inherited.shareId);
    return (
      !!row &&
      !row.requestId &&
      row.kind === "project" &&
      row.memberAssistantId === agent.id &&
      row.leadId === record.inherited.leadId &&
      row.projectId === record.projectId &&
      w.shares.live(row).coding === true &&
      w.access.sessionsEnabled(record.inherited.leadId, record.projectId)
    );
  } catch {
    return false;
  }
}

/**
 * The agent's own session `sessionId`: `{ record, session }`. NOT_FOUND when no
 * record exists, it belongs to another agent or the session is gone, so no other
 * session (the owner's included) is ever confirmed to exist; GRANT_REVOKED when
 * the agent or its grant (or, inherited, the lead's share or switch) is gone.
 */
export async function control(w, assistantId, sessionId) {
  const record = typeof sessionId === "string" ? w.sessions.store.get(sessionId) : null;
  if (!record || record.assistantId !== assistantId) throw notFound();
  let session;
  try {
    session = await w.s.sessions.get(sessionId);
  } catch (error) {
    if (error?.status === 404) throw notFound();
    throw error;
  }
  if (!session) throw notFound();
  if (!stillGranted(w, record)) throw revoked();
  return { record, session };
}
