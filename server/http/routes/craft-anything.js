import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";

/**
 * The managed Craft Anything tool (server/features/tools/craft-tool.js), under
 * /craft-anything, owner only like /rea. Refusals carry the German server text and its
 * message key, which the browser shows in the owner's language.
 */
export function craftRoutes(services) {
  const router = Router();
  const craft = () => {
    // Without the MCP server store there is no row for Craft Anything (503).
    if (!services.craft) throw assistantProblem("unavailable", 503);
    return services.craft;
  };
  router.use("/craft-anything", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/craft-anything", (_req, res) => res.json(craft().state()));
  router.post("/craft-anything", async (req, res) =>
    res.status(202).json(await craft().apply(req.body)),
  );
  router.post("/craft-anything/update", async (_req, res) =>
    res.status(202).json(await craft().update()),
  );
  router.delete("/craft-anything", async (_req, res) =>
    res.json(await craft().uninstall()),
  );
  return router;
}
