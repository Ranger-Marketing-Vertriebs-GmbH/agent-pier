import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { ownerApproval } from "../../features/users/approval-audience.js";
export function assistantWorkflowRoutes({ assistants }) {
  const router = Router(),
    service = () => {
      if (!assistants.workflows) throw assistantProblem("unavailable", 503);
      return assistants.workflows;
    };
  router.get("/assistant-workspace-catalog", async (_req, res) =>
    res.json({
      ...service().access.catalog(),
      // Each folder once: older rows of a folder are marked (projects hub rule).
      projects: await service().access.describedProjects(),
      // Token profiles (metadata only) and the managed GitHub MCP server's state.
      github: { profiles: service().github.catalog(), server: service().github.server() },
    }),
  );
  // Retries the managed GitHub MCP server's install after a failure.
  router.post("/assistant-github-server/install", (_req, res) => {
    service().s.githubMcp?.ensure();
    res.json(service().github.server());
  });
  router.get("/assistants/:id/access", (req, res) =>
    res.json(service().access.get(req.params.id)),
  );
  router.put("/assistants/:id/access", (req, res) =>
    assistants.admit(async () => {
      const { revision, ...input } = req.body;
      const previous = service().access.get(req.params.id);
      const before = previous.sshAccesses.length > 0;
      const saved = service().access.save(req.params.id, input, revision);
      // A changed GitHub access reaches the agent, its members and the MCP servers.
      if (JSON.stringify(previous.github) !== JSON.stringify(saved.github))
        await service().github.refresh([req.params.id]);
      // Gaining the first or losing the last grant changes the agent's tool list.
      if (before !== saved.sshAccesses.length > 0 && assistants.runtime?.client?.ready)
        await assistants.config.apply(req.params.id).catch(() => {});
      res.json(saved);
    }),
  );
  // A user's approvals are hers alone (approval-audience.js); the owner lists his.
  router.get("/assistants/:id/actions", (req, res) => {
    const { actions } = service().list(req.params.id, { delegated: true });
    const hidden = new Set(
      service()
        .store.list(req.params.id)
        .filter((a) => !ownerApproval(a, assistants.store))
        .map((a) => a.id),
    );
    res.json({ actions: actions.filter((a) => !hidden.has(a.id)) });
  });
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
