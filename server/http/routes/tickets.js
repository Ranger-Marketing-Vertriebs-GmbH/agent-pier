import { Router } from "express";
import { publicSession } from "../../features/sessions/session-public.js";

// Owner-only like every /api route outside /api/me (route-access.js). Responses carry
// connection metadata and failure codes, never a token.
export function ticketRoutes(services) {
  const { tickets, ticketSequences } = services;
  const router = Router();
  router.get("/ticket-connections", (req, res) => res.json(tickets.connectionsView()));
  router.post("/ticket-connections", (req, res) =>
    res.status(201).json({ connection: tickets.createConnection(req.body ?? {}) }),
  );
  router.put("/ticket-connections/:id", (req, res) =>
    res.json({ connection: tickets.updateConnection(req.params.id, req.body ?? {}) }),
  );
  router.delete("/ticket-connections/:id", (req, res) => {
    tickets.removeConnection(req.params.id);
    res.status(204).end();
  });
  router.get("/ticket-connections/:id/projects", async (req, res) =>
    res.json({ projects: await tickets.planeProjects(req.params.id) }),
  );
  router.get(
    "/ticket-connections/:id/projects/:planeProjectId/states",
    async (req, res) =>
      res.json({
        states: await tickets.planeStates(req.params.id, req.params.planeProjectId),
      }),
  );
  router.get("/tickets/projects/:projectId", async (req, res) =>
    res.json(await tickets.projectView(req.params.projectId)),
  );
  router.put("/tickets/projects/:projectId/sources", async (req, res) =>
    res.json(await tickets.setSources(req.params.projectId, req.body ?? {})),
  );
  router.get("/tickets/projects/:projectId/tickets", async (req, res) =>
    res.json(
      await tickets.listTickets(req.params.projectId, {
        source: req.query.source,
        label: req.query.label,
      }),
    ),
  );
  router.post("/tickets/projects/:projectId/start", async (req, res) => {
    const result = await tickets.start(req.params.projectId, req.body);
    res
      .status(201)
      .json(
        result.session ? { ...result, session: publicSession(result.session) } : result,
      );
  });
  const queue = "/tickets/projects/:projectId/queue";
  router.get(queue, async (req, res) =>
    res.json(await ticketSequences.view(req.params.projectId)),
  );
  router.post(queue, async (req, res) =>
    res.status(201).json(await ticketSequences.add(req.params.projectId, req.body)),
  );
  router.post(`${queue}/:itemId/retry`, async (req, res) =>
    res.json(await ticketSequences.retry(req.params.projectId, req.params.itemId)),
  );
  // `?force=true`: the owner confirmed to go on although GitHub could not be read.
  const force = (req) => ({ force: req.query.force === "true" });
  router.post(`${queue}/:itemId/done`, async (req, res) =>
    res.json(
      await ticketSequences.markDone(req.params.projectId, req.params.itemId, force(req)),
    ),
  );
  router.delete(`${queue}/:itemId`, async (req, res) =>
    res.json(
      await ticketSequences.remove(req.params.projectId, req.params.itemId, force(req)),
    ),
  );
  return router;
}
