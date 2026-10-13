import { Router } from "express";
import {
  artifactError,
  artifactSearch,
} from "../../features/artifacts/artifact-errors.js";
export function artifactsRoutes({ artifacts, audit, sessions, memory }) {
  const router = Router();
  // Search also finds artifacts by their session's or project's name. A source that
  // cannot be read narrows the search to titles instead of failing the list.
  async function namedMatches(search) {
    const needle = search.toLocaleLowerCase();
    const named = (rows) =>
      (rows || [])
        .filter((row) =>
          String(row?.name || "")
            .toLocaleLowerCase()
            .includes(needle),
        )
        .map((row) => row.id);
    const [sessionRows, projectRows] = await Promise.all([
      Promise.resolve()
        .then(() => sessions?.list())
        .catch(() => []),
      Promise.resolve()
        .then(() => memory?.projects().projects)
        .catch(() => []),
    ]);
    return [...named(sessionRows), ...named(projectRows)];
  }
  let bundles = 0;
  router.get("/artifacts", async (req, res) => {
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
        matches: search ? await namedMatches(search) : undefined,
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
