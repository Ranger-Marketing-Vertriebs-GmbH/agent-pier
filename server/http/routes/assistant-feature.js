import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
export function assistantFeatureRoutes({ assistantFeature, audit }) {
  const router = Router();
  router.get("/assistant-feature", (_req, res) => res.json(assistantFeature.state()));
  router.put("/assistant-feature", async (req, res) => {
    const body = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).length !== 1 ||
      typeof body.enabled !== "boolean"
    )
      throw assistantProblem("invalid");
    const state = body.enabled
      ? await assistantFeature.enable()
      : await assistantFeature.disable();
    audit.append({
      action: "setting.updated",
      resourceType: "setting",
      resourceId: "assistants",
      outcome: state.error ? "failure" : "success",
      source: "user",
      details: { enabled: state.enabled },
    });
    res.json(state);
  });
  return router;
}
