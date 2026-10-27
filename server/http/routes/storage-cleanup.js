import { Router } from "express";
import { cleanupProblem } from "../../features/system-status/cleanup-problem.js";

/*
 * Cleanup of the data directory (System status › Storage). Owner only, like every
 * /api route outside /api/me. The lists measure on request, the summary in the
 * background; a deletion answers with how many entries and bytes went, never a path.
 */
export function storageCleanupRoutes({ storageCleanup }) {
  const router = Router();
  const base = "/system-status/cleanup";
  router.use(base, (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  const empty = (body) =>
    body === undefined || (body && !Array.isArray(body) && !Object.keys(body).length);
  router.get(`${base}/summary`, (_req, res) => res.json(storageCleanup.summary()));
  router.get(`${base}/update-backups`, async (_req, res) =>
    res.json(await storageCleanup.snapshots()),
  );
  router.delete(`${base}/update-backups/:id`, async (req, res) =>
    res.json(await storageCleanup.deleteSnapshot(req.params.id, req.principal)),
  );
  router.get(`${base}/transcripts`, async (_req, res) =>
    res.json(await storageCleanup.transcripts()),
  );
  router.post(`${base}/transcripts/:id`, async (req, res) => {
    const keys = Object.keys(req.body || {});
    if (keys.length !== 1 || keys[0] !== "olderThanDays")
      throw cleanupProblem("invalidAge");
    res.json(
      await storageCleanup.deleteTranscripts(
        req.params.id,
        req.body.olderThanDays,
        req.principal,
      ),
    );
  });
  router.get(`${base}/dependencies`, async (_req, res) =>
    res.json(await storageCleanup.dependencies()),
  );
  router.delete(`${base}/dependencies/:id`, async (req, res) => {
    if (!empty(req.body)) throw cleanupProblem("notFound", 404);
    res.json(await storageCleanup.deleteDependencies(req.params.id, req.principal));
  });
  return router;
}
