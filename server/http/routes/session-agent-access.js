import { Router } from "express";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import {
  sessionAgentAccess,
  talkAgentChoices,
  talkAgentIds,
} from "../../features/session-talk/live-topics.js";

/** The agents one session may talk to (session-talk/session-agent-grants.js). */
export function sessionAgentAccessRoutes(services) {
  const router = Router();
  const { sessions, sessionAgentGrants } = services;
  router.get("/sessions/:id/agent-accesses", async (req, res) =>
    res.json(sessionAgentAccess(services, await sessions.get(req.params.id))),
  );
  router.put("/sessions/:id/agent-accesses", async (req, res) => {
    const body = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).length !== 1 ||
      !Array.isArray(body.assistantIds)
    )
      throw problem(serverMessages.sessions.invalidAgentAccess);
    const session = await sessions.get(req.params.id);
    sessionAgentGrants.set(session, talkAgentIds(services, body.assistantIds));
    res.json(sessionAgentAccess(services, session));
  });
  // The launch dialog's choice: the owner's agents (none while agents are off).
  router.get("/session-talk/agents", (_req, res) =>
    res.json({ agents: talkAgentChoices(services) }),
  );
  return router;
}
