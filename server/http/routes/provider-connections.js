import { Router } from "express";
export function providerConnectionRoutes({ providerConnections, endpointTester }) {
  const router = Router();
  router.get("/provider-connections", (_request, response) =>
    response.json({ connections: providerConnections.list() }),
  );
  router.post("/provider-connections", (request, response) =>
    response.status(201).json(providerConnections.create(request.body)),
  );
  router.post("/provider-connections/test", async (request, response) => {
    // A client that disconnects aborts the upstream requests and releases the test lock.
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    response.json(await endpointTester.test(request.body, controller.signal));
  });
  router.patch("/provider-connections/:id", (request, response) =>
    response.json(providerConnections.update(request.params.id, request.body)),
  );
  router.delete("/provider-connections/:id", (request, response) => {
    providerConnections.remove(request.params.id);
    response.status(204).end();
  });
  return router;
}
