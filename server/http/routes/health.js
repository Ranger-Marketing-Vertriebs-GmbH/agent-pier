import { Router } from "express";
import { applicationVersion } from "../../features/operations/version.js";

/** The running instance and its operational warnings, for the UI and the update path. */
export function healthRoutes(services) {
  const router = Router();
  router.get("/health", (_req, res) =>
    res.json({
      application: "agentpier",
      version: applicationVersion(),
      instanceId: services.instanceId,
      warnings: [...services.operationalWarnings],
    }),
  );
  return router;
}
