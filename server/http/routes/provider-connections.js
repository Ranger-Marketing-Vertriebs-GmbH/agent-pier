import { Router } from "express";
export function providerConnectionRoutes({ providerConnections }) {
  const router = Router();
  router.get("/provider-connections", (_request, response) =>
    response.json({ connections: providerConnections.list() }),
  );
  router.post("/provider-connections", (request, response) =>
    response.status(201).json(providerConnections.create(request.body)),
  );
  router.patch("/provider-connections/:id", (request, response) =>
    response.json(providerConnections.update(request.params.id, request.body)),
  );
  router.delete("/provider-connections/:id", (request, response) => {
    providerConnections.remove(request.params.id);
    response.status(204).end();
  });
  return router;
}
