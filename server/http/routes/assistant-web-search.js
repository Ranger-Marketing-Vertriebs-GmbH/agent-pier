import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { replyRestartRequired } from "./restart-required.js";

/** The agents' web search provider; keys are accepted but never returned. */
export function assistantWebSearchRoutes({
  assistantWebSearch: webSearch,
  assistantWebTools: webTools,
}) {
  const router = Router();
  router.use("/assistant-web-search", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/assistant-web-search", (_req, res) => res.json(webSearch.get()));
  router.put("/assistant-web-search", async (req, res) => {
    const body = req.body;
    const object = !!body && typeof body === "object" && !Array.isArray(body);
    const { confirmRestart, ...input } = object ? body : {};
    let result;
    try {
      // A changed provider or key restarts the Gateway once the owner confirms.
      result = await webTools.saveSearch(object ? input : body, {
        confirmed: confirmRestart === true,
      });
    } catch (error) {
      return replyRestartRequired(res, error);
    }
    res.json(result);
  });
  router.use("/assistant-web-search", (error, _req, _res, next) =>
    // Validation, conflicts and a busy Gateway keep their reason; storage and
    // runtime errors can carry private details.
    next(error.key ? error : assistantProblem("unavailable", 503)),
  );
  return router;
}
