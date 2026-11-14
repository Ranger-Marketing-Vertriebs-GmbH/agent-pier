// Which agents a coding session may talk to, and the other way round. An agent
// reaches a session through its project's talk grant (`talkProjectIds` within
// `projectIds`) or through the session's own grant (SessionAgentGrants, read through
// `w.s.sessionAgentGrants`). Only the owner's own agents take part: never a user
// agent, an archived agent or a temporary task member. Without a grant neither side
// sees the other. Nothing here throws: a failing read answers "no reach".
import { personalEligible } from "../native-capabilities.js";
import { isUserAgent } from "../../users/user-access.js";
import { talkEligible } from "../../session-talk/session-agent-grants.js";

/** The project a session is bound to, or null. */
export const sessionProjectId = (session) =>
  session?.sshTools?.project?.projectId ?? null;

/** The agent when it may take part in session talk at all, else null. */
export function talkAgent(w, assistantId) {
  try {
    const agent = w.access.eligible(assistantId);
    return personalEligible(agent) && !isUserAgent(agent) ? agent : null;
  } catch {
    return null;
  }
}

/** How the agent reaches `session`: "project", "session", or null (not at all). */
export function talkVia(w, assistantId, session) {
  try {
    if (!talkEligible(session) || !talkAgent(w, assistantId)) return null;
    const projectId = sessionProjectId(session);
    if (projectId) {
      const policy = w.access.get(assistantId);
      if (
        (policy.talkProjectIds || []).includes(projectId) &&
        policy.projectIds.includes(projectId)
      )
        return "project";
    }
    if (w.s.sessionAgentGrants?.assigned(session).includes(assistantId)) return "session";
  } catch {}
  return null;
}

/** The agents `session` may talk to, `[{ assistantId, name, via }]` by name. */
export function talkAgentsFor(w, session) {
  try {
    if (!talkEligible(session)) return [];
    return w.a.store
      .listAssistants()
      .map((agent) => ({
        assistantId: agent.id,
        name: agent.name,
        via: talkVia(w, agent.id, session),
      }))
      .filter((entry) => entry.via)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** The sessions the agent may talk to, `[{ session, via }]`. */
export async function talkSessionsFor(w, assistantId) {
  try {
    if (!talkAgent(w, assistantId)) return [];
    const sessions = await w.s.sessions.list();
    return sessions
      .map((session) => ({ session, via: talkVia(w, assistantId, session) }))
      .filter((entry) => entry.via);
  } catch {
    return [];
  }
}

/** Whether the session can answer with agent_tell and agent_ask (a live capability). */
export function sessionHasTools(w, sessionId) {
  try {
    return !!w.s.sessionMcp?.grantFor(sessionId);
  } catch {
    return false;
  }
}
