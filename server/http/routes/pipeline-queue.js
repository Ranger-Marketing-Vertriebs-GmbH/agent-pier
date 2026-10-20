import { Router } from "express";

// The owner's run queue of a registered project. MCP clients queue through the
// queue_* tools with their grant's checks (server/features/mcp/queue-tools.js).
export function pipelineQueueRoutes({
  pipelineQueue: queue,
  pipelineDefinitions,
  audit,
}) {
  const router = Router();
  const base = "/pipeline-queue/:projectId";
  router.get(base, (req, res) => res.json(queue.view(req.params.projectId)));
  router.put(`${base}/settings`, (req, res) => {
    queue.projects(req.params.projectId);
    const saved = pipelineDefinitions.saveQueueSettings(req.params.projectId, req.body);
    // How many runs may spend at once is the owner's recorded decision.
    audit?.append({
      action: "pipeline.updated",
      resourceType: "pipeline",
      projectId: req.params.projectId,
      source: "user",
      outcome: "success",
      details: {
        kind: "queue-settings",
        limit: saved.limit,
        countParked: saved.countParked,
      },
    });
    queue.notify(req.params.projectId);
    res.json({ limit: saved.limit, countParked: saved.countParked });
  });
  router.post(`${base}/items`, (req, res) =>
    res.status(201).json({ item: queue.add(req.params.projectId, req.body) }),
  );
  router.delete(`${base}/items/:itemId`, (req, res) => {
    queue.remove(req.params.projectId, req.params.itemId);
    res.sendStatus(204);
  });
  router.post(`${base}/items/:itemId/retry`, (req, res) =>
    res.json({ item: queue.retry(req.params.projectId, req.params.itemId) }),
  );
  router.post(`${base}/items/:itemId/move`, (req, res) =>
    res.json(queue.move(req.params.projectId, req.params.itemId, req.body?.direction)),
  );
  return router;
}
