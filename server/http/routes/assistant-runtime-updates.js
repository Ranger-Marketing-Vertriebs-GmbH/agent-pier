import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
export function assistantRuntimeUpdateRoutes({ assistantUpdates, assistants }) {
  const router = Router();
  router.use("/assistant-runtime/updates", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/assistant-runtime/updates", (_req, res) =>
    res.json(assistantUpdates.status()),
  );
  router.post("/assistant-runtime/updates/:action", async (req, res) => {
    if (
      !["stage", "activate", "recover"].includes(req.params.action) ||
      !req.body ||
      Array.isArray(req.body) ||
      Object.keys(req.body).length
    )
      throw assistantProblem("invalid");
    if (
      assistants?.maintenance &&
      !(req.params.action === "recover" && assistantUpdates.status().recoveryRequired)
    )
      throw assistantProblem("active", 409);
    res.json(await assistantUpdates[req.params.action]());
  });
  router.use((error, _req, _res, next) => {
    const key = { 400: "invalid", 409: "active" }[error.status];
    next(assistantProblem(key || "unavailable", key ? error.status : 503));
  });
  return router;
}
