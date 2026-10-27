import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";

/**
 * The managed REA tool (server/features/tools/rea-tool.js), under /rea so these never
 * meet `DELETE /tools/:id`. Refusals carry the German server text and its message key,
 * which the browser shows in the owner's language, like every other route.
 */
export function reaRoutes(services) {
  const router = Router();
  const rea = () => {
    // Without the MCP server store there is no row for REA (as /mcp-servers: 503).
    if (!services.rea) throw assistantProblem("unavailable", 503);
    return services.rea;
  };
  router.use("/rea", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/rea", (_req, res) => res.json(rea().state()));
  router.post("/rea", async (req, res) =>
    res.status(202).json(await rea().apply(req.body)),
  );
  router.post("/rea/update", async (_req, res) =>
    res.status(202).json(await rea().update()),
  );
  router.delete("/rea", async (_req, res) => res.json(await rea().uninstall()));
  return router;
}
