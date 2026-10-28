import { Router } from "express";

/**
 * Names the actors of audit entries by their current names: a user's entries get
 * `actorName` (null once she is deleted), an agent's own entries (source "agent",
 * the agent as `resourceId`) get `agentName` (null once it is deleted).
 */
export function namedAuditEvents(events, { users, assistants } = {}) {
  const userNames = new Map(
    (users?.list() || []).map((user) => [user.id, user.displayName]),
  );
  const agentNames = events.some((event) => event.source === "agent")
    ? new Map(
        (assistants?.store?.listAssistants() || []).map((agent) => [
          agent.id,
          agent.name,
        ]),
      )
    : new Map();
  return events.map((event) => {
    if (event.actorUserId !== undefined)
      return { ...event, actorName: userNames.get(event.actorUserId) ?? null };
    if (event.source === "agent")
      return { ...event, agentName: agentNames.get(event.resourceId) ?? null };
    return event;
  });
}

/** The owner's audit log. */
export function auditRoutes({ audit, users, assistants }) {
  const router = Router();
  router.get("/audit", (req, res) => {
    const page = audit.list(req.query);
    res.json({ ...page, events: namedAuditEvents(page.events, { users, assistants }) });
  });
  return router;
}
