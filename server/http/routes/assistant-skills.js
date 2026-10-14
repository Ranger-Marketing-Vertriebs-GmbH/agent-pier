import { Router } from "express";

/**
 * An agent's bundled OpenClaw skills with their status on the running Gateway
 * (agent-skills.js). The assignment itself is saved with the agent's PATCH.
 */
export function assistantSkillRoutes({ assistants }) {
  const router = Router();
  router.get("/assistants/:id/skills", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await assistants.skills.list(req.params.id));
  });
  return router;
}
