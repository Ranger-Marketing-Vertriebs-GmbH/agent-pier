import { Router } from "express";
import { artifactError } from "../../features/artifacts/artifact-errors.js";
export function artifactsRoutes({ artifacts, audit }) {
  const router = Router();
  let bundles = 0;
  router.get("/artifacts", async (req, res) => {
    res.json(
      await artifacts.list({
        sessionId: req.query.sessionId,
        projectId: req.query.projectId,
        page: req.query.page === undefined ? 1 : Number(req.query.page),
      }),
    );
  });
  router.get("/artifacts/usage", async (_req, res) => res.json(await artifacts.usage()));
  router.get("/artifacts/:id", async (req, res) =>
    res.json(await artifacts.get(req.params.id)),
  );
  router.get("/artifacts/:id/bundle", async (req, res) => {
    if (bundles >= 2) throw artifactError("ARTIFACT_BUSY", 503);
    bundles++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        bundles--;
      }
    };
    res.once("close", release);
    res.once("finish", release);
    try {
      res.json(await artifacts.snapshot(req.params.id));
    } catch (error) {
      release();
      throw error;
    }
  });
  router.patch("/artifacts/:id", async (req, res) => {
    if (
      !req.body ||
      Object.keys(req.body).length !== 1 ||
      typeof req.body.pinned !== "boolean"
    )
      throw artifactError("ARTIFACT_INVALID_INPUT");
    const result = await artifacts.setPinned(req.params.id, req.body.pinned);
    audit.append({
      action: "artifact.updated",
      resourceType: "artifact",
      resourceId: req.params.id,
      source: "user",
      outcome: "success",
    });
    res.json(result);
  });
  router.delete("/artifacts/:id", async (req, res) => {
    await artifacts.delete(req.params.id);
    audit.append({
      action: "artifact.deleted",
      resourceType: "artifact",
      resourceId: req.params.id,
      source: "user",
      outcome: "success",
    });
    res.status(204).end();
  });
  return router;
}
