import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { replyRestartRequired } from "./restart-required.js";

const text = (value) => typeof value === "string";
const only = (body, keys) => Object.keys(body).every((key) => keys.includes(key));

/**
 * The owner's advanced settings for all agents (advanced-config.js). A body names one
 * setting and its `value`; `null` resets it to its default. A shared setting is named
 * by its id (`setting`), a runtime's own by the runtime's id and the field's
 * (`runtime`, `field`); `confirmRestart` answers the restart question.
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
    if (!body || typeof body !== "object" || Array.isArray(body) || !("value" in body))
      throw assistantProblem("invalid");
    const shared =
      text(body.setting) && only(body, ["setting", "value", "confirmRestart"]);
    const own =
      text(body.runtime) &&
      text(body.field) &&
      only(body, ["runtime", "field", "value", "confirmRestart"]);
    if (!shared && !own) throw assistantProblem("invalid");
    const options = { confirmed: body.confirmRestart === true };
    let result;
    try {
      result = shared
        ? await advanced.save(body.setting, body.value, options)
        : await advanced.saveOwn(body.runtime, body.field, body.value, options);
    } catch (error) {
      return replyRestartRequired(res, error);
    }
    res.json(result);
  });
  router.use("/assistant-advanced-settings", (error, _req, _res, next) =>
    // Validation, conflicts and a busy host keep their reason; storage and
    // runtime errors can carry private configuration.
    next(error.key ? error : assistantProblem("unavailable", 503)),
  );
  return router;
}
