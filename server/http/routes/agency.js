import { Router } from "express";
export function agencyRoutes({ agency }) {
  const router = Router();
  router.get("/accounts/:id/agency", async (req, res) =>
    res.json(await agency.list(req.params.id, req.query)),
  );
  router.get("/accounts/:id/agency/preview", async (req, res) =>
    res.json(await agency.preview(req.params.id, req.query)),
  );
  router.post("/accounts/:id/agency", async (req, res) =>
    res.status(201).json(await agency.install(req.params.id, req.body)),
  );
  router.delete("/accounts/:id/agency/:agentId", (req, res) => {
    agency.remove(req.params.id, req.params.agentId);
    res.status(204).end();
  });
  return router;
}
