import { Router } from "express";
import { problem } from "../../lib/storage.js";

function pageValue(value) {
  if (value === undefined) return 1;
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > 100000
  )
    throw problem("Invalid pipeline page");
  return Number(value);
}
function filter(value, label) {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 100)
    throw problem(`Invalid ${label} filter`);
  return value;
}

export function pipelineRunRoutes({ pipelines }) {
  const router = Router();
  router.get("/pipeline-runs", (req, res) => {
    const status = filter(req.query.status, "status");
    if (
      status &&
      !["running", "awaiting-human", "completed", "failed", "cancelled"].includes(status)
    )
      throw problem("Invalid pipeline status");
    res.json(
      pipelines.list({
        page: pageValue(req.query.page),
        status,
        projectId: filter(req.query.projectId, "project"),
      }),
    );
  });
  router.post("/pipeline-runs", async (req, res) =>
    res.status(201).json({ run: await pipelines.start(req.body) }),
  );
  router.get("/pipeline-runs/:id", (req, res) =>
    res.json({ run: pipelines.get(req.params.id) }),
  );
  router.delete("/pipeline-runs/:id", async (req, res) => {
    await pipelines.delete(req.params.id);
    res.sendStatus(204);
  });
  router.post("/pipeline-runs/:id/gate", async (req, res) =>
    res.json({ run: await pipelines.gate(req.params.id, req.body) }),
  );
  for (const [endpoint, method] of [
    ["cancel", "cancel"],
    ["retry-stage", "retry"],
    ["pull-request", "createPr"],
  ])
    router.post(`/pipeline-runs/:id/${endpoint}`, async (req, res) =>
      res.json({ run: await pipelines[method](req.params.id) }),
    );
  router.get("/pipeline-runs/:id/verdict-status", (req, res) =>
    res.json(pipelines.verdictStatus(req.params.id)),
  );
  const node = "/pipeline-runs/:id/nodes/:nodeId";
  router.get(`${node}/artifacts`, (req, res) =>
    res.json(pipelines.artifacts(req.params.id, req.params.nodeId)),
  );
  router.get(`${node}/artifact`, (req, res) => {
    if (typeof req.query.path !== "string") throw problem("An artifact path is required");
    const result = pipelines.artifact(req.params.id, req.params.nodeId, req.query.path);
    res.json({ content: result.text, truncated: result.truncated });
  });
  router.get(`${node}/diff`, async (req, res) =>
    res.json(await pipelines.diff(req.params.id, req.params.nodeId)),
  );
  router.get(`${node}/verify-logs/:stepIdx`, (req, res) => {
    if (
      !/^\d+$/.test(req.params.stepIdx) ||
      !Number.isSafeInteger(Number(req.params.stepIdx))
    )
      throw problem("Invalid verification step");
    res.json(
      pipelines.verifyLogs(req.params.id, req.params.nodeId, Number(req.params.stepIdx)),
    );
  });
  return router;
}
