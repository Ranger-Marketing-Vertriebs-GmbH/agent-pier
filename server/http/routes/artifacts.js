import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { ArtifactNames } from "../../features/artifacts/artifact-names.js";
import {
  artifactError,
  artifactSearch,
} from "../../features/artifacts/artifact-errors.js";
export function artifactsRoutes({ artifacts, audit, sessions, memory }) {
  const router = Router();
  let bundles = 0;
  // Search also finds artifacts by their session's or project's name.
  const names = new ArtifactNames({
    sessions: () => sessions?.names(),
    projects: () => memory?.projectNames(),
  });
  // Searching may read session metadata (at most every few seconds); one owner budget
  // that 5 s polling and debounced typing in a few tabs stay well below.
  const searchLimit = rateLimit({
    windowMs: 60_000,
    limit: 120,
    keyGenerator: () => "owner",
    skip: (req) => req.query.q === undefined,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, _res, next) => next(artifactError("ARTIFACT_RATE_LIMITED", 429)),
  });
  router.get("/artifacts", searchLimit, async (req, res) => {
    const { q, pinned } = req.query;
    if (
      (q !== undefined && !artifactSearch(q)) ||
      (pinned !== undefined && pinned !== "true" && pinned !== "false")
    )
      throw artifactError("ARTIFACT_INVALID_INPUT");
    const search = q?.trim() || undefined;
    res.json(
      await artifacts.list({
        sessionId: req.query.sessionId,
        projectId: req.query.projectId,
        page: req.query.page === undefined ? 1 : Number(req.query.page),
        q: search,
        pinned: pinned === undefined ? undefined : pinned === "true",
        matches: search ? await names.matches(search) : undefined,
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
    if (await artifacts.delete(req.params.id))
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
