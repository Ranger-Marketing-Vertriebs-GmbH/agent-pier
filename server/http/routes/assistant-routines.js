import { Router } from "express";
import { serverMessages } from "../../lib/i18n/de.js";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
// Mount below the application owner authentication and CSRF middleware.
export function assistantRoutineRoutes({ assistantRoutines: routines }) {
  const router = Router(),
    base = "/assistants/:id/routines";
  router.use(base, (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get(base, async (req, res) => res.json(await routines.list(req.params.id)));
  router.post(base, async (req, res) =>
    res.status(201).json(await routines.create(req.params.id, req.body)),
  );
  router.patch(`${base}/:routineId`, async (req, res) =>
    res.json(await routines.update(req.params.id, req.params.routineId, req.body)),
  );
  router.delete(`${base}/:routineId`, async (req, res) =>
    res.json(await routines.remove(req.params.id, req.params.routineId)),
  );
  router.post(`${base}/:routineId/events`, async (req, res) =>
    res
      .status(202)
      .json(await routines.trigger(req.params.id, req.params.routineId, req.body)),
  );
  router.post(`${base}/:routineId/review`, async (req, res) =>
    res.json(await routines.review(req.params.id, req.params.routineId, req.body)),
  );
  router.get(`${base}/:routineId/runs`, async (req, res) =>
    res.json(await routines.runs(req.params.id, req.params.routineId)),
  );
  router.use((error, _req, _res, next) => {
    if (error.message === serverMessages.assistants.reminderChannelRequired)
      return next(assistantProblem("reminderChannelRequired", 409));
    if (error.message === serverMessages.assistants.reminderTimezoneRequired)
      return next(assistantProblem("reminderTimezoneRequired"));
    if (error.code === "REVIEW_REQUIRED") return next(error);
    const key = { 400: "invalid", 403: "invalid", 404: "notFound", 409: "conflict" }[
      error.status
    ];
    next(assistantProblem(key || "unavailable", key ? error.status : 503));
  });
  return router;
}
