import { Router } from "express";
import { directoryProblem } from "../../features/mcp-directory/directory-errors.js";

/**
 * The read-only MCP directory: status for the Source card, search and one entry's
 * latest version. Answers are normalised DTOs; nothing here installs or writes.
 */
export function mcpDirectoryRoutes(services) {
  const directory = () => {
    if (!services.mcpDirectory) throw directoryProblem("MCP_DIRECTORY_UNAVAILABLE");
    return services.mcpDirectory;
  };
  const text = (value) => (typeof value === "string" ? value : "");
  const router = Router();
  router.use("/mcp-directory", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/mcp-directory/status", async (_req, res) =>
    res.json(await directory().status()),
  );
  router.get("/mcp-directory/servers", async (req, res) =>
    res.json(
      await directory().search({
        search: text(req.query.search),
        cursor: text(req.query.cursor),
      }),
    ),
  );
  // Express decodes `%2F`, so `io.github.user/my-server` arrives as one name.
  router.get("/mcp-directory/servers/:name", async (req, res) =>
    res.json(await directory().detail(req.params.name)),
  );
  return router;
}
