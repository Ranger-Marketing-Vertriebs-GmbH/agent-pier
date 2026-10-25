import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
const hookReasons = ["hookUnavailable", "hookRightExceeds"];
// Mount below the application owner authentication and CSRF middleware.
export function assistantHookRoutes(services) {
  const hooks = () => services.assistantRoutines.hooks;
  // Without the hook service (no reminder runtime) every route is unavailable.
  const call = (name, ...args) => {
    const service = hooks();
    if (!service) throw assistantProblem("unavailable", 503);
    return service[name](...args);
  };
  const router = Router(),
    base = "/assistants/:id/hooks",
    one = `${base}/:hookId`;
  router.use(base, (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get(base, async (req, res) => res.json(await call("list", req.params.id)));
  router.post(base, async (req, res) =>
    res.status(201).json(await call("create", req.params.id, req.body)),
  );
  router.patch(one, async (req, res) =>
    res.json(await call("update", req.params.id, req.params.hookId, req.body)),
  );
  router.delete(one, async (req, res) =>
    res.json(await call("remove", req.params.id, req.params.hookId)),
  );
  router.post(`${one}/secret`, async (req, res) =>
    res.json(await call("secret", req.params.id, req.params.hookId, req.body)),
  );
  router.post(`${one}/test`, async (req, res) =>
    res.status(202).json(await call("test", req.params.id, req.params.hookId)),
  );
  router.get(`${one}/events/:eventId`, async (req, res) =>
    res.json(
      await call("eventDetail", req.params.id, req.params.hookId, req.params.eventId),
    ),
  );
  router.use(base, (error, _req, _res, next) => {
    // A hook refusal keeps its reason: the settings show why (paused, right missing).
    const key = hookReasons.includes(error.key)
      ? error.key
      : { 400: "invalid", 403: "invalid", 404: "notFound", 409: "conflict" }[
          error.status
        ];
    next(assistantProblem(key || "unavailable", key ? error.status : 503));
  });
  return router;
}
