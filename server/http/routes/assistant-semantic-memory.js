import { Router } from "express";

/**
 * The owner's semantic memory search (runtimes/openclaw/semantic-memory.js).
 * `GET` answers its status. `PUT { enabled, revision, acceptTerms }` starts the
 * switch and answers the status at once (202): the model download, the Gateway
 * restart and the index rebuild go on in the background and reach the browser over
 * the live topic `runtime.semantic-memory`. A refusal carries only its stable
 * `code`, which the web app translates.
 */
export function assistantSemanticMemoryRoutes({ assistantSemanticMemory: memory }) {
  const router = Router();
  router.use("/assistant-semantic-memory", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/assistant-semantic-memory", (_req, res) => res.json(memory.status()));
  router.put("/assistant-semantic-memory", (req, res) => {
    const body = req.body;
    const input = !!body && typeof body === "object" && !Array.isArray(body) ? body : {};
    try {
      res.status(202).json(
        memory.set({
          enabled: input.enabled,
          revision: input.revision,
          acceptTerms: input.acceptTerms,
        }),
      );
    } catch (error) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(error?.code || "")) throw error;
      const code = `SEMANTIC_MEMORY_${error.code}`;
      res.status(error.status === 400 ? 400 : 409).json({ code, error: code });
    }
  });
  return router;
}
