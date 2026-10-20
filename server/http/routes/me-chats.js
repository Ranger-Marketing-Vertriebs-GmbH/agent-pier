import { Router } from "express";

/**
 * A user's chat list with each of her agents (AGENTPIER-181). Every level may start
 * chats; another user's or the owner's chats never show, and an agent that does not
 * serve her is the unknown-route 404 (user-scope.js).
 */
export function meChatRoutes({ assistants, userScope }) {
  const router = Router();
  router.get("/me/agents/:id/chats", (req, res) => {
    const agent = userScope.agentOf(req.principal, req.params.id);
    res.json(
      assistants.chats.list(agent.id, {
        userId: req.principal.userId,
        archived: req.query.archived === "1",
      }),
    );
  });
  router.post("/me/agents/:id/chats", async (req, res) => {
    const agent = userScope.agentOf(req.principal, req.params.id);
    const conversation = await assistants.chats.create(agent.id, {
      userId: req.principal.userId,
    });
    res.status(201).json(assistants.chats.summary(conversation.id));
  });
  return router;
}
