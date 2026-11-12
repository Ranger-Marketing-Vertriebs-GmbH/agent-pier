import { Router } from "express";
import { OWNER_ORDER } from "../../features/assistants/agent-order.js";

// The owner's own order of his agent list (agent-order.js), the users' agents in his
// view included; it never changes a user's order. Protected by the same
// authentication and write/maintenance guards as /assistants, and wakes agent.list.
export function assistantOrderRoutes({ assistants }) {
  const router = Router();
  router.put("/assistant-order", (req, res) =>
    assistants.admit(() => {
      const known = new Set(
        assistants.store
          .listAssistants()
          .filter((agent) => !agent.deletingAt)
          .map((agent) => agent.id),
      );
      const result = assistants.agentOrder.save(OWNER_ORDER, req.body?.ids, (id) =>
        known.has(id),
      );
      assistants.changed({ feeds: false });
      res.json(result);
    }),
  );
  return router;
}
