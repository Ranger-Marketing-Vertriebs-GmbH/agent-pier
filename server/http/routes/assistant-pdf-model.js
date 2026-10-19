import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { replyRestartRequired } from "./restart-required.js";

/** The one model agents read PDFs with; ids only, the connection keeps its key. */
export function assistantPdfModelRoutes({
  assistantPdfModel: pdfModel,
  assistantWebTools: webTools,
}) {
  const router = Router();
  router.use("/assistant-pdf-model", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/assistant-pdf-model", (_req, res) => res.json(pdfModel.get()));
  router.put("/assistant-pdf-model", async (req, res) => {
    const body = req.body;
    const object = !!body && typeof body === "object" && !Array.isArray(body);
    const { confirmRestart, ...input } = object ? body : {};
    let result;
    try {
      // A changed model for agents that read PDFs restarts the Gateway once the
      // owner confirms.
      result = await webTools.savePdfModel(object ? input : body, {
        confirmed: confirmRestart === true,
      });
    } catch (error) {
      return replyRestartRequired(res, error);
    }
    res.json(result);
  });
  router.use("/assistant-pdf-model", (error, _req, _res, next) =>
    next(error.key ? error : assistantProblem("unavailable", 503)),
  );
  return router;
}
