import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { replyRestartRequired } from "./restart-required.js";

/**
 * The owner's advanced OpenClaw settings (advanced-config.js). A body names one
 * allowed `path` and its `value`; `null` resets it to OpenClaw's default.
 */
export function assistantAdvancedSettingsRoutes({ assistantAdvancedConfig: advanced }) {
  const router = Router();
  router.use("/assistant-advanced-settings", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/assistant-advanced-settings", async (_req, res) =>
    res.json(await advanced.get()),
  );
  router.put("/assistant-advanced-settings", async (req, res) => {
    const body = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.path !== "string" ||
      !("value" in body) ||
      Object.keys(body).some((key) => !["path", "value", "confirmRestart"].includes(key))
    )
      throw assistantProblem("invalid");
    let result;
    try {
      result = await advanced.save(body.path, body.value, {
        confirmed: body.confirmRestart === true,
      });
    } catch (error) {
      return replyRestartRequired(res, error);
    }
    res.json(result);
  });
  router.use("/assistant-advanced-settings", (error, _req, _res, next) =>
    // Validation, conflicts and a busy Gateway keep their reason; storage and
    // runtime errors can carry private configuration.
    next(error.key ? error : assistantProblem("unavailable", 503)),
  );
  return router;
}
