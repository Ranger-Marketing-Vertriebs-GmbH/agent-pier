import { Router } from "express";

/**
 * The previews: the list (the REST fallback of the `previews` live topic) and Stop.
 * Owner only, as every route outside /api/me (route-access.js).
 */
export function previewsRoutes({ previews }) {
  const router = Router();
  router.get("/previews", async (_req, res) => {
    res.json(await previews.view());
  });
  router.delete("/previews/:id", async (req, res) => {
    await previews.close(req.params.id, { reason: "owner", source: "user" });
    res.status(204).end();
  });
  return router;
}
