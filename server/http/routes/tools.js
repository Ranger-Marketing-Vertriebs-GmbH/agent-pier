import { Router } from "express";

export function toolsRoutes(services) {
  const { installer } = services;
  const router = Router();
  router.post("/tools/:id/update", async (req, res) =>
    res.status(202).json(installer.startUpdate(req.params.id)),
  );
  router.get("/tool-installations", async (_req, res) => res.json(installer.list()));
  router.post("/tools/:id/install", async (req, res) =>
    res.status(202).json(installer.start(req.params.id, req.body?.method || "native")),
  );
  return router;
}
