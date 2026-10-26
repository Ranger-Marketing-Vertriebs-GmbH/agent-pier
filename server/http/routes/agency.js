import { Router } from "express";
import { templatePreview } from "../../features/agency/agency-templates.js";
export function agencyRoutes({ agency, agencyTemplates }) {
  const router = Router();
  router.get("/accounts/:id/agency", async (req, res) =>
    res.json(await agency.list(req.params.id, req.query)),
  );
  router.get("/accounts/:id/agency/preview", async (req, res) =>
    res.json(await agency.preview(req.params.id, req.query)),
  );
  router.post("/accounts/:id/agency", async (req, res) =>
    res.status(201).json(await agency.install(req.params.id, req.body)),
  );
  // Which CLIs hold each installed entry (the Vorlagen list's "In n CLIs").
  router.get("/agency/installed", (_req, res) =>
    res.json({ tools: agency.installedTools() }),
  );
  // Agency agents as templates for AgentPier agents (agency-templates.js).
  router.get("/agency/templates", async (req, res) =>
    res.json(await agencyTemplates.search(req.query)),
  );
  router.get("/agency/templates/preview", async (req, res) => {
    const t = await agencyTemplates.template({
      id: req.query.id,
      ...(req.query.revision ? { revision: req.query.revision } : {}),
    });
    res.json(templatePreview(t));
  });
  router.delete("/accounts/:id/agency/:agentId", (req, res) => {
    agency.remove(req.params.id, req.params.agentId);
    res.status(204).end();
  });
  return router;
}
