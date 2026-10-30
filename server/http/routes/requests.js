import { Router } from "express";
import { problem } from "../../lib/storage.js";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";

export function requestsRoutes({ requests, sessions }) {
  const router = Router();
  router.get("/sessions/:id/requests", async (req, res) =>
    res.json(await requests.list(req.params.id)),
  );
  for (const operation of ["answer", "handoff", "touch"])
    router.post(`/sessions/:id/requests/:requestId/${operation}`, async (req, res) =>
      res.json(await requests[operation](req.params.id, req.params.requestId, req.body)),
    );
  // Approvals remembered for a project and for the sessions in its folders
  // (request-approvals.js); a session rule names its session.
  router.get("/remembered-approvals", async (req, res) => {
    const projectId = req.query.project;
    if (typeof projectId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId))
      throw problem(copy.invalid, 400);
    const rules = await Promise.all(
      requests.approvals.list(projectId).map(async (rule) => {
        if (rule.scope !== "session") return rule;
        const session = await Promise.resolve(sessions?.get(rule.target)).catch(
          () => null,
        );
        return { ...rule, sessionName: session?.name || null };
      }),
    );
    res.json({ rules });
  });
  router.delete("/remembered-approvals/:id", async (req, res) => {
    requests.approvals.remove(req.params.id);
    res.json({ removed: req.params.id });
  });
  return router;
}
