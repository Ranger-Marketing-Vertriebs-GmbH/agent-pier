import { Router } from "express";
export function requestsRoutes({ requests }) {
  const router = Router();
  router.get("/sessions/:id/requests", async (req, res) =>
    res.json(await requests.list(req.params.id)),
  );
  for (const operation of ["answer", "handoff"])
    router.post(`/sessions/:id/requests/:requestId/${operation}`, async (req, res) =>
      res.json(await requests[operation](req.params.id, req.params.requestId, req.body)),
    );
  return router;
}
