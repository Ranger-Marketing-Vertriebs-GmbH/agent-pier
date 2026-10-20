import { Router } from "express";
import {
  approvalAudience,
  awaitingForUser,
} from "../../features/users/approval-audience.js";

/**
 * The approvals of a user's own chats: what her agents ask her to allow. Another
 * user's or the owner's approval is not found.
 */
export function meApprovalRoutes({ assistants, userScope }) {
  const router = Router();
  const mine = (userId, action) => {
    const audience = approvalAudience(action, assistants.store);
    return audience.kind === "user" && audience.userId === userId;
  };
  router.get("/me/approvals", (req, res) => {
    const workflows = assistants.workflows;
    const actions = awaitingForUser({ assistants, userScope }, req.principal);
    res.json({ actions: actions.map((action) => workflows.project(action)) });
  });
  router.post("/me/approvals/:id/decision", async (req, res) => {
    const workflows = assistants.workflows;
    let action;
    try {
      action = workflows.store.get(req.params.id);
    } catch {
      throw userScope.refusal();
    }
    if (!mine(req.principal.userId, action)) throw userScope.refusal();
    userScope.conversationOf(req.principal, action.conversationId);
    res.json(
      await workflows.decide(req.params.id, req.body, {
        kind: "user",
        userId: req.principal.userId,
        channel: "ui",
      }),
    );
  });
  return router;
}
