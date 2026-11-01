import { Router } from "express";
import { isDeepStrictEqual } from "node:util";
import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { remoteLocked } from "./remote.js";

/**
 * The previews: the list (the REST fallback of the `previews` live topic), the settings
 * and Stop. Owner only, as every route outside /api/me (route-access.js).
 */
export function previewsRoutes({ previews }) {
  const router = Router();
  router.get("/previews", async (_req, res) => {
    res.json(await previews.view());
  });
  router.put("/previews/settings", async (req, res) => {
    const next = previews.checked(req.body);
    // Like /remote: a request over the plain network may only switch previews off.
    if (
      remoteLocked(req) &&
      !isDeepStrictEqual(next, { ...previews.settings(), enabled: false })
    )
      throw problem(serverMessages.settings.networkLocked, 403);
    res.json(await previews.configure(next, { source: "user" }));
  });
  router.delete("/previews/:id", async (req, res) => {
    await previews.close(req.params.id, { reason: "owner", source: "user" });
    res.status(204).end();
  });
  return router;
}
