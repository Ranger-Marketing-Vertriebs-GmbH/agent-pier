import { Router, raw } from "express";
import { ownsMutationLeases } from "../../application/mutation-barrier.js";
import {
  craftRebuildsService,
  craftRebuildsView,
} from "../../features/craft/live-topics.js";
import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { pictureLimits } from "../../features/craft/rebuild-pictures.js";

// One raw picture; one byte over the limit still reaches the route, which answers
// with its own message, and a larger body is translated below.
const pictureBody = raw({
  type: "application/octet-stream",
  limit: pictureLimits.maxBytes + 1,
});
const pictureTooLarge = (error, _req, _res, next) =>
  next(
    error?.type === "entity.too.large"
      ? problem(serverMessages.craft.rebuildPictureTooLarge, 413)
      : error,
  );

/**
 * Craft Anything rebuilds (server/features/craft/craft-rebuilds.js) under /craft, owner
 * only by default (route-access.js). Without the supervisor every route answers 503;
 * its refusals (400, 404, 409) pass through with their message keys.
 */
export function craftRebuildsRoutes(services) {
  const router = Router();
  const rebuilds = () => craftRebuildsService(services);
  router.use("/craft", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/craft/rebuilds", (_req, res) => res.json(craftRebuildsView(services)));
  // Starting, following up and continuing wait for Craft Anything (a child's start,
  // rebuild_start): the supervisor takes the mutation lease only around its folder and
  // project changes (CraftRebuilds#begin), so these routes hold none themselves.
  router.post(
    "/craft/rebuilds",
    ownsMutationLeases(async (req, res) =>
      res.status(201).json(await rebuilds().start(req.body, { source: "owner" })),
    ),
  );
  // A picture of the original for the next start or follow-up (rebuild-pictures.js):
  // checked by its bytes and staged; its id goes into `pictures` of that request.
  router.post("/craft/pictures", pictureBody, pictureTooLarge, async (req, res) => {
    if (!req.is("application/octet-stream"))
      throw problem(serverMessages.craft.rebuildPictureType, 415);
    res.status(201).json(await rebuilds().pictures.stage(req.body));
  });
  // The form dropped a picture it staged (removed, abandoned): it goes at once. An id
  // that no longer waits, or that a start has taken, changes nothing.
  router.delete("/craft/pictures/:id", (req, res) => {
    rebuilds().pictures.release([req.params.id]);
    res.status(204).end();
  });
  router.put("/craft/settings", async (req, res) =>
    res.json(await rebuilds().saveSettings(req.body)),
  );
  router.get("/craft/rebuilds/:id", (req, res) => {
    const view = rebuilds().get(req.params.id);
    if (!view) throw problem(serverMessages.craft.rebuildNotFound, 404);
    res.json({ rebuild: view });
  });
  router.delete("/craft/rebuilds/:id", async (req, res) => {
    await rebuilds().remove(req.params.id);
    res.status(204).end();
  });
  router.post(
    "/craft/rebuilds/:id/follow-up",
    ownsMutationLeases(async (req, res) =>
      res.json(
        await rebuilds().followUp(req.params.id, req.body?.request, req.body?.pictures),
      ),
    ),
  );
  router.post(
    "/craft/rebuilds/:id/continue",
    ownsMutationLeases(async (req, res) =>
      res.json(await rebuilds().continue(req.params.id)),
    ),
  );
  router.post("/craft/rebuilds/:id/pause", async (req, res) =>
    res.json(await rebuilds().pause(req.params.id)),
  );
  router.post("/craft/rebuilds/:id/answer", async (req, res) =>
    res.json(await rebuilds().answer(req.params.id, req.body?.questionId, req.body)),
  );
  router.post("/craft/rebuilds/:id/auto-mode", async (req, res) =>
    res.json(await rebuilds().setAutoMode(req.params.id, req.body?.on)),
  );
  router.get("/craft/rebuilds/:id/activity", async (req, res) => {
    // A missing, empty or non-integer limit reads the default.
    const raw = typeof req.query.limit === "string" ? req.query.limit.trim() : "";
    const limit = raw ? Number(raw) : NaN;
    res.json(
      await rebuilds().activity(req.params.id, {
        limit: Number.isInteger(limit) ? limit : undefined,
      }),
    );
  });
  return router;
}
