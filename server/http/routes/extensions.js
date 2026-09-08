import { Router } from "express";

export function extensionsRoutes(services) {
  const { extensions } = services;
  const router = Router();
  router.post("/accounts/:id/extensions/share", (req, res) =>
    res.json(services.sharedProfiles.migrate(req.params.id)),
  );
  router.get("/accounts/:id/extensions", async (req, res) =>
    res.json(await extensions.list(req.params.id)),
  );
  router.post("/accounts/:id/extensions/mcp", async (req, res) =>
    res.status(201).json(await extensions.addMcp(req.params.id, req.body)),
  );
  router.delete("/accounts/:id/extensions/mcp/:name", async (req, res) => {
    await extensions.removeMcp(req.params.id, req.params.name);
    res.status(204).end();
  });
  router.post("/accounts/:id/extensions/skills", async (req, res) =>
    res.status(201).json(await extensions.installSkill(req.params.id, req.body)),
  );
  router.delete("/accounts/:id/extensions/skills/:skillId", async (req, res) => {
    await extensions.removeSkill(req.params.id, req.params.skillId);
    res.status(204).end();
  });
  return router;
}
