import { Router } from "express";

const at = (value) => Date.parse(value || "");

/**
 * How the owner's chat list shows a conversation: his own chats whole, a user's only
 * under her opt-in (owner-privacy.js) and only once it was active from its `since`
 * on. A chat she started before that keeps its title to herself: the title comes
 * from her first message.
 */
export function ownerChatView(privacy) {
  return (conversation) => {
    if (typeof conversation.userId !== "string") return conversation;
    const { readable, since } = privacy?.conversation(conversation) ?? {};
    if (!readable) return null;
    if (!since) return conversation;
    const sinceMs = at(since);
    if (!(at(conversation.lastActivityAt || conversation.createdAt) >= sinceMs))
      return null;
    return at(conversation.createdAt) >= sinceMs
      ? conversation
      : { ...conversation, title: null };
  };
}

/**
 * The owner's chat lists (AGENTPIER-181): every agent can hold several chats. The
 * privacy guard (owner-content-guard.js) has already refused a user's own agent
 * without her opt-in, and any change to one.
 */
export function assistantChatRoutes({ assistants, ownerPrivacy }) {
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
  return router;
}
