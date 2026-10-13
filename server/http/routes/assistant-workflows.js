import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
export function assistantWorkflowRoutes({ assistants }) {
  const router = Router(),
    service = () => {
      if (!assistants.workflows) throw assistantProblem("unavailable", 503);
      return assistants.workflows;
    };
  router.get("/assistant-workspace-catalog", (_req, res) =>
    res.json(service().access.catalog()),
  );
  router.get("/assistants/:id/access", (req, res) =>
    res.json(service().access.get(req.params.id)),
  );
  router.put("/assistants/:id/access", (req, res) =>
    assistants.admit(() => {
      const { revision, ...input } = req.body;
      res.json(service().access.save(req.params.id, input, revision));
    }),
  );
  router.get("/assistants/:id/actions", (req, res) =>
    res.json(service().list(req.params.id)),
  );
  router.post("/assistant-actions/:id/decision", async (req, res) =>
    res.json(
      await service().decide(req.params.id, req.body, { kind: "owner", channel: "ui" }),
    ),
  );
  router.post("/assistants/:id/actions/:actionId/cancel", async (req, res) =>
    assistants.admit(async () => {
      if (Object.keys(req.body || {}).length) throw assistantProblem("invalid");
      res.json(
        await service().coding.call(req.params.id, req.params.actionId, "run_cancel"),
      );
    }),
  );
  router.get("/assistants/:id/actions/:actionId/artifacts", async (req, res) =>
    res.json(
      await service().coding.call(req.params.id, req.params.actionId, "run_artifacts", {
        nodeId: req.query.nodeId,
      }),
    ),
  );
  router.use(assistantErrors);
  return router;
}

/**
 * Maps errors of the workflow services an agent route calls (projects, pipelines) to
 * agent message keys, so a client never sees a foreign key or status.
 */
export function assistantErrors(error, _req, _res, next) {
  // Problems carry the German text; its key says whether it is already an agent one.
  const messageKey = error.messageKey ?? messageIdentity(error.message).messageKey;
  if (messageKey?.startsWith("assistants.")) return next(error);
  const key = { 400: "invalid", 403: "invalid", 404: "notFound", 409: "conflict" }[
    error.status
  ];
  next(assistantProblem(key || "unavailable", key ? error.status : 503));
}
