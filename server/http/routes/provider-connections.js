import { Router } from "express";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
export function providerConnectionRoutes(services) {
  const { providerConnections, endpointTester } = services;
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
  // Assistants can be switched on or off at runtime, so resolve them per request.
  // Changing a connection an agent uses restarts its Gateway; the owner confirms that.
  const change = (request, operation) =>
    services.assistantProviderSynchronization
      ? services.assistantProviderSynchronization.change(request.params.id, operation, {
          confirmed: request.body?.confirmRestart === true,
        })
      : operation();
  const restartRequired = (response, error) => {
    if (error?.code !== "ASSISTANT_RESTART_REQUIRED") throw error;
    response.status(409).json({
      code: error.code,
      error: error.message,
      ...(error.affected ? { affected: error.affected } : {}),
      ...messageIdentity(error.message),
    });
  };
  const withoutConfirmation = (body) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body;
    const { confirmRestart: _confirmRestart, ...rest } = body;
    return rest;
  };
  router.patch("/provider-connections/:id", async (request, response) => {
    let result;
    try {
      result = await change(request, () =>
        providerConnections.update(request.params.id, withoutConfirmation(request.body)),
      );
    } catch (error) {
      return restartRequired(response, error);
    }
    response.json(result);
  });
  router.delete("/provider-connections/:id", async (request, response) => {
    try {
      await change(request, () => providerConnections.remove(request.params.id));
    } catch (error) {
      return restartRequired(response, error);
    }
    response.status(204).end();
  });
  return router;
}
