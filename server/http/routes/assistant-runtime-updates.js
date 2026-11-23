import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { resolution } from "../../features/assistants/runtime-update-resolution.js";
const updateFailures = {
  UPDATE_BLOCKED: ["updateBlocked", 409],
  UPDATE_CONFIG_BUSY: ["configBusy", 503],
  UPDATE_PREPARE_FAILED: ["updatePrepareFailed", 503],
  // An activation that failed and rolled back cleanly: the previous runtime and its
  // data are back and the staged pin can be activated again, so the service is not
  // unavailable. Its diagnostic and failed step are in the status.
  UPDATE_ROLLED_BACK: ["updateRolledBack", 409],
  UPDATE_MIGRATION_FAILED: ["updateRolledBack", 409],
};
export function assistantRuntimeUpdateRoutes({ assistantUpdates, assistants }) {
  const router = Router();
  router.use("/assistant-runtime/updates", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/assistant-runtime/updates", (_req, res) =>
    res.json(assistantUpdates.status()),
  );
  // What would block an activation now, for the confirmation of "Pause agents and
  // update"; read only.
  router.get("/assistant-runtime/updates/blockers", async (_req, res) =>
    res.json({ items: await assistantUpdates.blockerPreview() }),
  );
  router.post("/assistant-runtime/updates/:action", async (req, res) => {
    if (
      !["stage", "activate", "recover"].includes(req.params.action) ||
      !req.body ||
      Array.isArray(req.body) ||
      (Object.keys(req.body).length &&
        !(req.params.action === "activate" && resolution(req.body)))
    )
      throw assistantProblem("invalid");
    if (
      assistants?.maintenance &&
      !(req.params.action === "recover" && assistantUpdates.status().recoveryRequired)
    )
      throw assistantProblem("active", 409);
    res.json(
      await assistantUpdates[req.params.action](
        Object.keys(req.body).length ? resolution(req.body) : undefined,
      ),
    );
  });
  router.use((error, _req, _res, next) => {
    // An activation refused before anything changed says why; the status names
    // the blockers (AssistantRuntimeUpdates.jsx).
    const known = updateFailures[error.code];
    if (known) return next(assistantProblem(known[0], known[1]));
    const key = { 400: "invalid", 409: "active" }[error.status];
    next(assistantProblem(key || "unavailable", key ? error.status : 503));
  });
  return router;
}
