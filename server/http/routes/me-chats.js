import { Router } from "express";
import { chatDeleted, confirmDelete, renameTitle } from "./assistant-chats.js";
import {
  archiveChat,
  deleteChat,
  restoreChat,
} from "../../features/assistants/chat-removal.js";

/**
 * A user's chat list with each of her agents (AGENTPIER-181). Every level may start
 * chats; another user's or the owner's chats never show, and an agent that does not
 * serve her is the unknown-route 404 (user-scope.js).
 */
export function meChatRoutes({ assistants, userScope, audit }) {
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
  router.patch("/me/conversations/:id", (req, res) => {
    const { id } = userScope.conversationOf(req.principal, req.params.id);
    res.json(assistants.chats.rename(id, renameTitle(req.body)));
  });
  router.post("/me/conversations/:id/archive", async (req, res) => {
    const { id } = userScope.conversationOf(req.principal, req.params.id);
    res.json(await archiveChat(assistants, id));
  });
  router.post("/me/conversations/:id/restore", async (req, res) => {
    const { id } = userScope.conversationOf(req.principal, req.params.id);
    res.json(await restoreChat(assistants, id));
  });
  // Her long chat's hint (long-chats.js): summarise it now, or hide the hint.
  router.post("/me/conversations/:id/compact", async (req, res) => {
    const { id } = userScope.conversationOf(req.principal, req.params.id);
    res.json(await assistants.longChats.summarise(id));
  });
  router.post("/me/conversations/:id/long-chat-dismissal", async (req, res) => {
    const { id } = userScope.conversationOf(req.principal, req.params.id);
    res.json(await assistants.longChats.dismiss(id));
  });
  router.delete("/me/conversations/:id", async (req, res) => {
    const { id } = userScope.conversationOf(req.principal, req.params.id);
    confirmDelete(req.body);
    const deleted = await deleteChat(assistants, id);
    audit.append(chatDeleted(deleted, { actorUserId: req.principal.userId }));
    res.status(204).end();
  });
  return router;
}
