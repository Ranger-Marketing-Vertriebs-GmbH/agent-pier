import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { resolution } from "./assistant-runtime-updates.js";

/**
 * The owner's Hermes Agent opt-in (application/hermes-wiring.js), an agent route:
 * GET reports it, PUT `{ enabled }` records it; enabling installs the pinned Hermes
 * runtime in the background (`installing`, then `installed` or `error`); POST
 * `/update` activates the version this AgentPier pins (`updating` until done), with
 * `{ resolveBlockers: true, items }` after resolving the work the owner confirmed
 * ("Pause agents and update"); GET `/update/blockers` lists what blocks it now.
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
  // Installs the pinned Hermes beside the selected one and activates it; the Hermes
  // agents restart, and a failed start rolls back (application/hermes-wiring.js).
  router.get("/assistant-runtime/hermes/update/blockers", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ items: await hermesRuntime.blockerPreview() });
  });
  router.post("/assistant-runtime/hermes/update", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const forced = Object.keys(body).length ? resolution(body) : undefined;
    if (forced === null || Array.isArray(req.body)) throw assistantProblem("invalid");
    const before = hermesRuntime.state();
    if (!before.enabled || !before.installed)
      throw assistantProblem("hermesUnavailable", 409);
    const state = await hermesRuntime.update(forced);
    audit.append({
      action: "setting.updated",
      resourceType: "setting",
      resourceId: "hermes",
      outcome: "success",
      source: "user",
      details: {
        update: before.targetVersion,
        ...(forced && { resolveBlockers: true, items: forced.items.length }),
      },
    });
    res.status(202).json(state);
  });
  return router;
}
