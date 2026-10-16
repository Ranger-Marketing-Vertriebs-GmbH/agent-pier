import { Router } from "express";
import { resolveCommand } from "../../features/mcp-servers/command-resolution.js";

/**
 * The wizard's own-command lookup: the same PATH resolution a save uses, answered as
 * found or not. Nothing is executed; the name is never logged. Kept apart from
 * /mcp-servers/:id so no server id can be mistaken for it.
 */
export function mcpCommandRoutes(services) {
  const router = Router();
  router.get("/mcp-commands/resolve", (req, res) => {
    res.set("Cache-Control", "no-store");
    const name = typeof req.query.name === "string" ? req.query.name : "";
    try {
      res.json({
        found: true,
        path: resolveCommand(name, services.mcpServers?.resolveOptions),
      });
    } catch {
      res.json({ found: false });
    }
  });
  return router;
}
