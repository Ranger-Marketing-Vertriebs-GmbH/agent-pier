import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { listDirectories, createDirectory } from "../../lib/directories.js";
import { workspaceStateOf } from "../../features/sessions/workspace-state.js";
import { readSandboxProfiles } from "../../features/nono/nono-profiles.js";
export const SANDBOX_PROFILES_PER_MINUTE = 120;
export function workspaceRoutes(services) {
  const { config, preferences, directory, nonoSandbox, accounts } = services;
  const router = Router();
  // The live `state` topic pushes the same value. A REST read is an explicit one (a
  // refresh after a write, `stale`, the fallback), so it detects the CLIs again.
  router.get("/state", async (_req, res) =>
    res.json(await workspaceStateOf(services).read({ fresh: true })),
  );
  // The profile list runs `nono profile list` and looks at account folders. This
  // router is behind owner authentication, so one shared owner budget: the launch
  // dialog reads the list once each time it opens, far below this.
  const sandboxProfilesLimit = rateLimit({
    windowMs: 60_000,
    limit: SANDBOX_PROFILES_PER_MINUTE,
    keyGenerator: () => "owner",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) =>
      res
        .status(429)
        .set("Cache-Control", "no-store")
        .json({
          code: "SANDBOX_PROFILES_RATE_LIMITED",
          error: serverMessages.sessions.sandboxProfilesRateLimited,
          ...messageIdentity(serverMessages.sessions.sandboxProfilesRateLimited),
        }),
  });
  router.get("/sandbox-profiles", sandboxProfilesLimit, async (_req, res) => {
    const executable = nonoSandbox.executable();
    if (!executable) return res.json({ available: false, profiles: [] });
    // Accounts whose login a sandboxed session cannot read (managed-logins.js).
    const hidden = accounts?.hiddenLogins() || {};
    res.json({
      available: true,
      profiles: await readSandboxProfiles({ executable }),
      ...(Object.keys(hidden).length ? { hiddenLogins: hidden } : {}),
    });
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
