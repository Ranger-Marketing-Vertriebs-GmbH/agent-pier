import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";

const at = (value) => Date.parse(value || "");

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
  // The guard refuses a user's chat: only she renames it (me-chats.js).
  router.patch("/assistant-conversations/:id", (req, res) =>
    res.json(
      assistants.chats.rename(req.params.id, renameTitle(req.body), { owner: true }),
    ),
  );
  return router;
}
