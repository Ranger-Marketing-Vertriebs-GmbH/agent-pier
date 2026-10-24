import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { chatProblem } from "../../features/assistants/agent-chats.js";
import {
  archiveChat,
  deleteChat,
  restoreChat,
} from "../../features/assistants/chat-removal.js";

/** A delete names its confirmation: `{confirm: true}`, or a 400. */
export function confirmDelete(body) {
  if (body?.confirm !== true) throw chatProblem("CHAT_CONFIRM");
}

/** The audit record of a deleted chat: its agent, never its title. */
export const chatDeleted = (conversation, actor = {}) => ({
  action: "assistant.updated",
  resourceType: "assistant",
  resourceId: conversation.assistantId,
  outcome: "success",
  source: "user",
  ...actor,
  details: { kind: "chat-deleted" },
});

/** The title of a rename body (`{title}` and nothing else), or a 400. */
export function renameTitle(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => k !== "title")
  )
    throw assistantProblem("invalid");
  return body.title;
}

/** How the owner's chat list shows a conversation (users/owner-privacy.js). */
export function ownerChatView(privacy) {
  return (conversation) => (privacy ? privacy.view(conversation) : conversation);
}

/**
 * The owner's chat lists (AGENTPIER-181): every agent can hold several chats. The
 * privacy guard (owner-content-guard.js) has already refused a user's own agent
 * without her opt-in, and any change to one.
 */
export function assistantChatRoutes({ assistants, ownerPrivacy, audit }) {
  const router = Router();
  router.get("/assistants/:id/chats", (req, res) => {
    assistants.store.getAssistant(req.params.id);
    res.json(
      assistants.chats.list(req.params.id, {
        archived: req.query.archived === "1",
        view: ownerChatView(ownerPrivacy),
      }),
    );
  });
  router.post("/assistants/:id/chats", async (req, res) => {
    const conversation = await assistants.chats.create(req.params.id);
    res.status(201).json(assistants.chats.summary(conversation.id, { owner: true }));
  });
  // The guard refuses a user's chat: only she renames it (me-chats.js).
  router.patch("/assistant-conversations/:id", (req, res) =>
    res.json(
      assistants.chats.rename(req.params.id, renameTitle(req.body), { owner: true }),
    ),
  );
  router.post("/assistant-conversations/:id/archive", async (req, res) => {
    await archiveChat(assistants, req.params.id);
    res.json(assistants.chats.summary(req.params.id, { owner: true }));
  });
  router.post("/assistant-conversations/:id/restore", async (req, res) => {
    await restoreChat(assistants, req.params.id);
    res.json(assistants.chats.summary(req.params.id, { owner: true }));
  });
  // The long-chat hint (long-chats.js): his own chats only, the guard refuses hers.
  router.post("/assistant-conversations/:id/compact", async (req, res) =>
    res.json(await assistants.longChats.summarise(req.params.id)),
  );
  // The owner's Stop of a work goal (work-goals.js); the guard refuses hers.
  router.post("/assistant-conversations/:id/goal/stop", (req, res) =>
    res.json(assistants.teams.goals.stop(req.params.id)),
  );
  router.post("/assistant-conversations/:id/long-chat-dismissal", async (req, res) =>
    res.json(await assistants.longChats.dismiss(req.params.id)),
  );
  router.delete("/assistant-conversations/:id", async (req, res) => {
    confirmDelete(req.body);
    audit.append(chatDeleted(await deleteChat(assistants, req.params.id)));
    res.status(204).end();
  });
  return router;
}
