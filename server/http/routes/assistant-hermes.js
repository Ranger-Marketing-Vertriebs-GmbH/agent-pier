import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";

/**
 * The owner's Hermes Agent opt-in (application/hermes-wiring.js), an agent route:
 * GET reports it, PUT `{ enabled }` records it; enabling installs the pinned Hermes
 * runtime in the background (`installing`, then `installed` or `error`).
 */
export function assistantHermesRoutes({ hermesRuntime, audit }) {
  const router = Router();
  if (!hermesRuntime) return router;
  router.get("/assistant-runtime/hermes", (_req, res) => res.json(hermesRuntime.state()));
  router.put("/assistant-runtime/hermes", async (req, res) => {
    const body = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).length !== 1 ||
      typeof body.enabled !== "boolean"
    )
      throw assistantProblem("invalid");
    const state = body.enabled
      ? await hermesRuntime.enable()
      : await hermesRuntime.disable();
    audit.append({
      action: "setting.updated",
      resourceType: "setting",
      resourceId: "hermes",
      outcome: "success",
      source: "user",
      details: { enabled: state.enabled },
    });
    res.json(state);
  });
  return router;
}
