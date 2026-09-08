import { Router } from "express";

export function pluginsRoutes(services) {
  const { plugins } = services;
  const router = Router();
  router.get("/accounts/:id/plugins", async (req, res) =>
    res.json(await plugins.list(req.params.id)),
  );
  router.post("/accounts/:id/plugins", async (req, res) =>
    res.json(await plugins.mutate(req.params.id, req.body)),
  );
  return router;
}
