import { Router } from "express";
import { problem } from "../../lib/storage.js";

export function providerRoutes({ providerCatalog }) {
  const router = Router();
  router.get("/providers", (_request, response) =>
    response.json({
      providers: providerCatalog.providers(),
      status: providerCatalog.status(),
    }),
  );
  router.get("/providers/:id/models", (request, response) => {
    const tool = request.query.tool;
    if (tool !== undefined && !["codex", "claude", "opencode"].includes(tool))
      throw problem("Unknown coding CLI.");
    const models = providerCatalog.list({ providerId: request.params.id, tool });
    response.json({ models, status: providerCatalog.status()[request.params.id] });
  });
  router.post("/providers/:id/refresh", async (request, response) =>
    response.json(await providerCatalog.refresh(request.params.id)),
  );
  return router;
}
