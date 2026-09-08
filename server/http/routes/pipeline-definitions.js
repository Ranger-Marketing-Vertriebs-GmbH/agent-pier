import { Router } from "express";
import { problem } from "../../lib/storage.js";

export function pipelineDefinitionRoutes({
  pipelineDefinitions: definitions,
  pipelines,
  pipelineDriver,
  memory,
}) {
  const router = Router();
  router.get("/pipeline-profiles", (req, res) => {
    if (req.query.enabled !== undefined && !["true", "false"].includes(req.query.enabled))
      throw problem("Invalid enabled filter");
    res.json({
      profiles: definitions.listProfiles({ enabledOnly: req.query.enabled === "true" }),
    });
  });
  router.post("/pipeline-profiles", (req, res) =>
    res.status(201).json({ profile: definitions.saveProfile(req.body) }),
  );
  router.get("/pipeline-profiles/:id", (req, res) =>
    res.json({ profile: definitions.getProfile(req.params.id) }),
  );
  router.patch("/pipeline-profiles/:id", (req, res) =>
    res.json({ profile: definitions.saveProfile(req.body, req.params.id) }),
  );
  router.delete("/pipeline-profiles/:id", (req, res) => {
    definitions.removeProfile(req.params.id);
    res.sendStatus(204);
  });
  router.get("/pipeline-profiles/:id/stats", (req, res) => {
    definitions.getProfile(req.params.id);
    res.json(pipelines.profileStats(req.params.id));
  });
  router.post("/pipeline-profiles/:id/launch", async (req, res) => {
    const profile = definitions.getProfile(req.params.id);
    if (!profile.enabled) throw problem("This profile is disabled", 409);
    res
      .status(201)
      .json({ session: await pipelineDriver.launchProfile(profile, req.body) });
  });
  router.get("/pipelines", (_req, res) =>
    res.json({ pipelines: definitions.listPipelines() }),
  );
  router.post("/pipelines", (req, res) =>
    res.status(201).json({ pipeline: definitions.savePipeline(req.body) }),
  );
  router.get("/pipelines/:id", (req, res) =>
    res.json({ pipeline: definitions.getPipeline(req.params.id) }),
  );
  router.patch("/pipelines/:id", (req, res) =>
    res.json({ pipeline: definitions.savePipeline(req.body, req.params.id) }),
  );
  router.delete("/pipelines/:id", (req, res) => {
    if (pipelines.hasActiveRuns(req.params.id))
      throw problem("A pipeline with active runs cannot be deleted", 409);
    definitions.removePipeline(req.params.id);
    res.sendStatus(204);
  });
  const project = (id) => {
    memory.project(id);
  };
  router.get("/pipeline-verification/:projectId", (req, res) => {
    project(req.params.projectId);
    res.json(definitions.getVerification(req.params.projectId));
  });
  router.put("/pipeline-verification/:projectId", (req, res) => {
    project(req.params.projectId);
    res.json(definitions.saveVerification(req.params.projectId, req.body));
  });
  return router;
}
