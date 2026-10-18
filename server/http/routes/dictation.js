import { Router } from "express";

/** Whether the composers can offer live dictation (dictation-service.js). */
export function dictationRoutes(services) {
  const router = Router();
  router.get("/dictation", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(services.dictation.status());
  });
  return router;
}
