import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { replyRestartRequired } from "./restart-required.js";

/** Mounted behind owner authentication, route access and origin checks. */
export function assistantBrowserNetworkRoutes({ assistantWebTools: webTools }) {
  const router = Router();
  const route = "/assistant-browser-network";
  router.use(route, (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get(route, (_req, res) => res.json(webTools.networkStatus()));
  router.put(route, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw assistantProblem("invalid");
    const { confirmRestart, ...input } = body;
    try {
      res.json(
        await webTools.saveBrowserNetwork(input, { confirmed: confirmRestart === true }),
      );
    } catch (error) {
      return replyRestartRequired(res, error);
    }
  });
  router.use(route, (error, _req, _res, next) =>
    next(error.key ? error : assistantProblem("unavailable", 503)),
  );
  return router;
}
