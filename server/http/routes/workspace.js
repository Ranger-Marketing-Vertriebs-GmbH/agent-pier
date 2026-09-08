import { Router } from "express";
import { listDirectories, createDirectory } from "../../lib/directories.js";
import { detectUtilities } from "../../features/accounts/account-store.js";
import { toolBinDirectories } from "../../features/tools/tool-paths.js";
import { SessionProjects } from "../../features/sessions/session-projects.js";
export function workspaceRoutes(services) {
  const { config, tools, accounts, sessions, activity, preferences, directory } =
    services;
  const router = Router();
  const projects = new SessionProjects();
  router.get("/state", async (_req, res) =>
    res.json({
      tools: tools(),
      utilities: detectUtilities(
        { ...process.env, HOME: config.home },
        true,
        toolBinDirectories(config.dataDir),
      ),
      accounts: accounts.list(),
      sharedCliExtensions: true,
      providerConnections: services.providerConnections.list(),
      sessions: await projects.enrich(await activity.enrich(await sessions.list())),
      home: config.home,
      ...preferences.get(),
      remoteUrl: config.remoteUrl || null,
    }),
  );
  router.get("/preferences", (_req, res) => res.json(preferences.get()));
  router.patch("/preferences", async (req, res) =>
    res.json(await preferences.update(req.body)),
  );
  router.get("/directories", async (req, res) => {
    const dir = await directory(req.query.path || config.home);
    res.json(await listDirectories(dir));
  });
  router.post("/directories", async (req, res) => {
    const parent = await directory(req.body?.path);
    res.status(201).json(await createDirectory(parent, req.body?.name));
  });
  return router;
}
