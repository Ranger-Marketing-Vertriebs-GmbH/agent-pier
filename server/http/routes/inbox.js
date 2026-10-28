import { Router } from "express";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { inboxTypes } from "../../features/inbox/inbox-items.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

// The owner's inbox: what waits for a decision, read only. Answers go through each
// source's own endpoint, which also keeps their checks in one place.
export function inboxRoutes({ inbox }) {
  const router = Router();
  router.get("/inbox", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await inbox.snapshot());
  });
  router.get("/inbox/:type/:id", async (req, res) => {
    const { type, id } = req.params;
    if (!inboxTypes.includes(type) || !idPattern.test(id))
      throw problem(serverMessages.http.notFound, 404);
    res.set("Cache-Control", "no-store");
    res.json(await inbox.status(type, id));
  });
  return router;
}
