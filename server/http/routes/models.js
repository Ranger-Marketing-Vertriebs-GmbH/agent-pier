import { requireChatInput } from "../../application/request-input-guard.js";
import { Router } from "express";

export function modelsRoutes(services) {
  const { models, requests } = services;
  const router = Router();
  router.get("/sessions/:id/models", async (req, res) =>
    res.json(await models.read(req.params.id)),
  );
  for (const operation of ["open", "select", "cancel", "search"])
    router.post(`/sessions/:id/models/${operation}`, async (req, res) => {
      await requireChatInput(requests, req.params.id);
      res.json(await models[operation](req.params.id, req.body));
    });
  return router;
}
