import { Router } from "express";

// Owner routes, protected by the same authentication and write/maintenance guards
// as /assistants. Every successful write wakes the existing agent.list topic.
export function assistantGroupRoutes({ assistants, audit }) {
  const router = Router();
  const write = (res, action, run, status = 200) =>
    assistants.admit(() => {
      const result = run();
      audit.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: result.assistantId || result.id,
        outcome: "success",
        source: "user",
        details: { fields: ["agentGroups"], operation: action },
      });
      assistants.changed({ feeds: false });
      res.status(status).json(result);
    });
  router.post("/assistant-groups", (req, res) =>
    write(res, "create", () => assistants.agentGroups.create(req.body?.name), 201),
  );
  router.patch("/assistant-groups/:id", (req, res) =>
    write(res, "rename", () =>
      assistants.agentGroups.rename(req.params.id, req.body || {}),
    ),
  );
  router.post("/assistant-groups/:id/order", (req, res) =>
    write(res, "reorder", () =>
      assistants.agentGroups.reorder(req.params.id, req.body || {}),
    ),
  );
  router.delete("/assistant-groups/:id", (req, res) =>
    write(res, "delete", () =>
      assistants.agentGroups.remove(req.params.id, req.body || {}),
    ),
  );
  router.put("/assistants/:id/group", (req, res) =>
    write(res, "assign", () =>
      assistants.agentGroups.assign(req.params.id, req.body || {}),
    ),
  );
  return router;
}
