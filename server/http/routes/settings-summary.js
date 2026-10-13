import { Router } from "express";
import { settingsSummary } from "../../features/settings/settings-summary.js";

export function settingsSummaryRoutes(services) {
  const router = Router();
  router.get("/settings/summary", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(settingsSummary(services));
  });
  return router;
}
