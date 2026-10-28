import { Router } from "express";
import { listDirectories, createDirectory } from "../../lib/directories.js";
import { workspaceStateOf } from "../../features/sessions/workspace-state.js";
import { readSandboxProfiles } from "../../features/nono/nono-profiles.js";
export function workspaceRoutes(services) {
  const { config, preferences, directory, nonoSandbox } = services;
  const router = Router();
  // The live `state` topic pushes the same value. A REST read is an explicit one (a
  // refresh after a write, `stale`, the fallback), so it detects the CLIs again.
  router.get("/state", async (_req, res) =>
    res.json(await workspaceStateOf(services).read({ fresh: true })),
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
