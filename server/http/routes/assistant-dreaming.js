import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";

/**
 * The owner's dreaming switch. A 409 that names agents (memory to confirm, or agents
 * busy right now) carries them, with its code when it has one.
 */
export function assistantDreamingRoutes({ assistantDreaming: dreaming }) {
  const router = Router();
  router.use("/assistant-dreaming", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/assistant-dreaming", (_req, res) => res.json(dreaming.get()));
  router.put("/assistant-dreaming", async (req, res) => {
    const body = req.body;
    const object = !!body && typeof body === "object" && !Array.isArray(body);
    const { revision, ...input } = object ? body : {};
    try {
      res.json(await dreaming.save(input, revision));
    } catch (error) {
      if (error?.status !== 409 || !Array.isArray(error.agents)) throw error;
      res.status(409).json({
        ...(error.code ? { code: error.code } : {}),
        error: error.message,
        agents: error.agents,
        ...messageIdentity(error.message),
      });
    }
  });
  router.use("/assistant-dreaming", (error, _req, _res, next) =>
    next(error.key ? error : assistantProblem("unavailable", 503)),
  );
  return router;
}
