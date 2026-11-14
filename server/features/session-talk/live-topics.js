// A session's agent access: the value GET /api/sessions/:id/agent-accesses answers,
// the agent checks of its PUT and of a launch's `agentAccessIds`, and the live
// `session.agent-access:<sessionId>` topic (owner only) that pushes that value.
// SessionAgentGrants signals every change of a session's own grant; every `change`
// event of the agent services (a project's talk grant, an agent renamed, archived or
// shared with a user) and agents switched on or off read every session again.
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { SESSION_PARAM } from "../requests/live-topics.js";
import { followAgentList } from "../assistants/live-topics.js";
import { talkAgent, talkVia } from "../assistants/session-talk/talk-reach.js";

const workflows = (services) => services.assistants?.workflows ?? null;

/** The owner's agents a session may be granted, `[{ id, name }]` by name. */
export function talkAgentChoices(services) {
  const w = workflows(services);
  if (!w) return [];
  try {
    return w.a.store
      .listAssistants()
      .filter((agent) => talkAgent(w, agent.id))
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * The agent ids of a PUT or a launch, validated: 400 for a malformed list or an
 * agent that may not take part, 409 for a non-empty list while agents are off.
 */
export function talkAgentIds(services, ids) {
  const valid = services.sessionAgentGrants.validate(ids);
  if (!valid.length) return valid;
  const w = workflows(services);
  if (!w) throw problem(serverMessages.assistants.disabled, 409);
  if (valid.some((id) => !talkAgent(w, id)))
    throw problem(serverMessages.sessions.invalidAgentAccess);
  return valid;
}

/**
 * What GET /api/sessions/:id/agent-accesses answers for `session`. `assignedIds` holds
 * only listed agents: one archived since the grant drops out, so echoing the value
 * back in a PUT never fails.
 */
export function sessionAgentAccess(services, session) {
  const w = workflows(services);
  const agents = talkAgentChoices(services);
  const listed = new Set(agents.map((a) => a.id));
  return {
    agents,
    assignedIds: services.sessionAgentGrants
      .assigned(session)
      .filter((id) => listed.has(id)),
    inheritedIds: w
      ? agents.filter((a) => talkVia(w, a.id, session) === "project").map((a) => a.id)
      : [],
    tools: services.sessionMcp?.grantFor(session.id) ? "ready" : "missing",
  };
}

/** The grant of `sessionId` changed. */
export function sessionAgentAccessChanged(hub, sessionId) {
  hub?.invalidate("session.agent-access", sessionId);
}

/**
 * The topic definition for LiveHub#define. Wires SessionAgentGrants#onChange to the
 * application's hub (`services.live`, read when a grant changes).
 */
export function sessionAgentAccessTopic(services) {
  if (services.sessionAgentGrants)
    services.sessionAgentGrants.onChange = (sessionId) =>
      sessionAgentAccessChanged(services.live, sessionId);
  return {
    name: "session.agent-access",
    mode: "state",
    param: SESSION_PARAM,
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read: async (_principal, id) =>
      sessionAgentAccess(services, await services.sessions.get(id)),
    watch: ({ invalidate }) => followAgentList(services, () => invalidate()),
  };
}
