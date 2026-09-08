import { Router } from "express";
export function auditRoutes({ audit }) {
  const router = Router();
  router.get("/audit", (req, res) => res.json(audit.list(req.query)));
  return router;
}
