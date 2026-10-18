import { Router } from "express";

// Host load and AgentPier's share of it; every /api route requires the owner login.
export function systemStatusRoutes({ systemStatus }) {
  const router = Router();
  router.get("/system-status", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await systemStatus.summary());
  });
  router.get("/system-status/details", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await systemStatus.details());
  });
  return router;
}
