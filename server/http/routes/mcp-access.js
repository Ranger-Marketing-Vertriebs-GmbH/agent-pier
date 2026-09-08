import { Router } from "express";

// Mounted behind the application owner authentication and mutation guards.
export function mcpAccessRoutes({ mcpAccess }) {
  const router = Router();
  router.use("/mcp-access", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get("/mcp-access", (_request, response) => response.json(mcpAccess.status()));
  router.get("/mcp-access/grants", (request, response) =>
    response.json(mcpAccess.listGrants(request.query)),
  );
  router.get("/mcp-access/authorizations/:id", (request, response) =>
    response.json(mcpAccess.consent(request.params.id)),
  );
  router.post("/mcp-access/authorizations/:id/approve", (request, response) =>
    response.json(mcpAccess.approve(request.params.id, request.body)),
  );
  router.post("/mcp-access/authorizations/:id/deny", (request, response) =>
    response.json(mcpAccess.deny(request.params.id)),
  );
  router.post("/mcp-access/grants/:id/revoke", (request, response) =>
    response.json(mcpAccess.revoke(request.params.id)),
  );
  return router;
}
