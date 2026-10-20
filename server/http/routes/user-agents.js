import { Router } from "express";
import { UserAgents } from "../../features/users/user-agents.js";

/**
 * The owner's agents for restricted users. Mounted with the agent routes, so they
 * answer ASSISTANTS_DISABLED while agents are off; users never reach them (route-access.js).
 */
export function userAgentRoutes(services) {
  const router = Router();
  const agents = new UserAgents(services);
  const audit = (action, id) =>
    services.audit.append({
      action,
      resourceType: "assistant",
      resourceId: id,
      outcome: "success",
      source: "user",
      details: { fields: ["userAccess"] },
    });
  router.post("/user-agents", async (req, res) => {
    const result = await agents.create(req.body);
    audit("assistant.created", result.id);
    res.status(201).json(result);
  });
  router.put("/user-agents/:id/access", async (req, res) => {
    const result = await agents.assign(req.params.id, req.body);
    audit("assistant.updated", result.id);
    res.json(result);
  });
  return router;
}
