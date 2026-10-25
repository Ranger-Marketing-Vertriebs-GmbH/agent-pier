import { Router } from "express";
import { connectionUsage } from "../../features/accounts/connection-usage.js";
import { connectionProblems } from "../../features/accounts/connection-problems.js";

// Zugänge: who uses each shared credential and which entries have problems. Both are
// owner-only reads (route-access.js) that change nothing.
export function connectionsRoutes(services) {
  const router = Router();
  router.get("/connections/usage", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await connectionUsage(services));
  });
  router.get("/connections/problems", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await connectionProblems(services));
  });
  return router;
}
