import { Router } from "express";

/**
 * The status with older project rows of a folder marked like in the projects hub
 * (`duplicateOf`, `pipelineWork`), so the consent page lists each folder once
 * (web/lib/project-list.js). Grants and approval still see every row.
 */
async function describedStatus(status, { memory, projectDuplicates }) {
  if (!memory || !projectDuplicates || !status.resources?.projects?.length) return status;
  const marks = new Map(
    (await projectDuplicates.describe(memory.projects().projects)).map(
      ({ id, duplicateOf, pipelineWork }) => [
        id,
        {
          ...(duplicateOf ? { duplicateOf } : {}),
          ...(pipelineWork !== undefined ? { pipelineWork } : {}),
        },
      ],
    ),
  );
  return {
    ...status,
    resources: {
      ...status.resources,
      projects: status.resources.projects.map((project) => ({
        ...project,
        ...marks.get(project.id),
      })),
    },
  };
}

// Mounted behind the application owner authentication and mutation guards.
export function mcpAccessRoutes({ mcpAccess, memory, projectDuplicates }) {
  const router = Router();
  router.use("/mcp-access", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get("/mcp-access", async (_request, response) =>
    response.json(
      await describedStatus(mcpAccess.status(), { memory, projectDuplicates }),
    ),
  );
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
