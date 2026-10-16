import { Router } from "express";
import { findCommand } from "../../features/mcp-servers/command-resolution.js";

/**
 * The wizard's own-command lookup: the path a save would resolve, answered as found
 * or not. Nothing is executed; the name is never logged. Kept apart from
 * /mcp-servers/:id so no server id can be mistaken for it.
 */
export function mcpCommandRoutes(services) {
  const router = Router();
  router.get("/mcp-commands/resolve", (req, res) => {
    res.set("Cache-Control", "no-store");
    const name = typeof req.query.name === "string" ? req.query.name : "";
    const found = findCommand(name, services.mcpServers?.resolveOptions);
    res.json(found ? { found: true, path: found } : { found: false });
  });
  return router;
}
