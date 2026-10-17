import path from "node:path";
import { Router } from "express";
import { listDirectories, createDirectory } from "../../lib/directories.js";
import { detectUtilities } from "../../features/accounts/account-store.js";
import { toolBinDirectories } from "../../features/tools/tool-paths.js";
import { chromiumUtility } from "../../features/tools/chromium-installer.js";
import { SessionProjects } from "../../features/sessions/session-projects.js";
import { readSandboxProfiles } from "../../features/nono/nono-profiles.js";
import { isManagedInstall, withCliVersions } from "../../features/tools/cli-version.js";
export function workspaceRoutes(services) {
  const {
    config,
    tools,
    accounts,
    sessions,
    activity,
    preferences,
    directory,
    nonoSandbox,
  } = services;
  const router = Router();
  const projects = new SessionProjects();
  router.get("/state", async (_req, res) =>
    res.json({
      // Never waits for a probe: a slow --version must not delay the app.
      tools: await withCliVersions(tools(), {
        managed: (tool) =>
          isManagedInstall(tool.id, tool.path, {
            home: config.home,
            dataDir: config.dataDir,
          }),
      }),
      utilities: [
        ...detectUtilities(
          { ...process.env, HOME: config.home },
          true,
          toolBinDirectories(config.dataDir),
        ),
        // The managed agent browser, which only AgentPier installs.
        ...(config.dataDir ? [chromiumUtility(path.join(config.dataDir, "clis"))] : []),
      ],
      accounts: accounts.list(),
      sharedCliExtensions: true,
      providerConnections: services.providerConnections.list(),
      sessions: await projects.enrich(await activity.enrich(await sessions.list())),
      home: config.home,
      ...preferences.get(),
      remoteUrl: config.remoteUrl || null,
    }),
  );
  router.get("/sandbox-profiles", async (_req, res) => {
    const executable = nonoSandbox.executable();
    if (!executable) return res.json({ available: false, profiles: [] });
    res.json({ available: true, profiles: await readSandboxProfiles({ executable }) });
  });
  router.get("/preferences", (_req, res) => res.json(preferences.get()));
  router.patch("/preferences", async (req, res) => {
    const updated = await preferences.update(req.body);
    // A changed directory setting starts from an empty cache (another base, or off).
    if (req.body?.mcpDirectory !== undefined) services.mcpDirectory?.clear();
    // Sessions interrupted while the setting was off are resumed once it is turned on.
    if (req.body?.autoResumeInterrupted === true)
      services.autoResume
        ?.notify()
        .catch((error) =>
          console.error(
            `AgentPier could not resume interrupted sessions: ${error?.code || error?.message || "unknown error"}`,
          ),
        );
    res.json(updated);
  });
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
