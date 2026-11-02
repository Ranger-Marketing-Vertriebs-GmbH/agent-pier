import { modelFamily } from "./model-family.js";
import { refuseClosedChat } from "./conversation-turns.js";

/** The table of dismissed model hints, per chat and person (private: private-tables.js). */
export const modelHintTable =
  "CREATE TABLE IF NOT EXISTS assistant_model_hint_dismissals (conversation_id TEXT NOT NULL, person TEXT NOT NULL, from_family TEXT NOT NULL, to_family TEXT NOT NULL, dismissed_at TEXT NOT NULL, PRIMARY KEY(conversation_id, person))";

// Whose chat it is: a user's own, or the owner's.
const personOf = (conversation) =>
  typeof conversation.userId === "string" ? conversation.userId : "owner";

/**
 * The hint in an older chat whose last turns ran on another model family than the
 * agent uses now (a main chat gets fresh chats at a switch instead). Each person
 * dismisses it for herself, for the pair of families it named.
 */
export class ModelHints {
  constructor(db) {
    this.db = db;
    db.exec(modelHintTable);
  }
  /** Whether the person is shown the hint for a chat that began on `conversation.family`. */
  shown(conversation, currentFamily, personId = personOf(conversation)) {
    const from = conversation.family;
    if (typeof from !== "string" || !from || from === currentFamily) return false;
    if (conversation.main === true) return false;
    const row = this.db
      .prepare(
        "SELECT from_family, to_family FROM assistant_model_hint_dismissals WHERE conversation_id=? AND person=?",
      )
      .get(conversation.id, personId);
    return !(row && row.from_family === from && row.to_family === currentFamily);
  }
  dismiss(conversationId, personId, fromFamily, toFamily, now = Date.now()) {
    this.db
      .prepare(
        "INSERT INTO assistant_model_hint_dismissals VALUES(?,?,?,?,?) ON CONFLICT(conversation_id, person) DO UPDATE SET from_family=excluded.from_family, to_family=excluded.to_family, dismissed_at=excluded.dismissed_at",
      )
      .run(conversationId, personId, fromFamily, toFamily, new Date(now).toISOString());
  }
  forget(conversationId) {
    this.db
      .prepare("DELETE FROM assistant_model_hint_dismissals WHERE conversation_id=?")
      .run(conversationId);
  }
}

// The family of the model the agent runs on now (a temporary member's lead's included).
const currentFamily = (service, conversation) =>
  modelFamily(
    service.store.getAssistant(conversation.assistantId).model,
    service.models.connections,
  );

/** Records the family a turn runs on, for the hint. Never throws. */
export function recordFamily(service, conversation) {
  try {
    const family = currentFamily(service, conversation);
    if (service.store.getConversation(conversation.id).family !== family)
      service.store.updateConversation(conversation.id, { family });
  } catch {
    /* The hint is a courtesy: a turn never fails for it. */
  }
}

/** Whether the chat's person sees the hint now; never throws. */
export function modelHintShown(service, conversation) {
  try {
    return !!service.longChats?.modelHints.shown(
      conversation,
      currentFamily(service, conversation),
    );
  } catch {
    return false;
  }
}

/** Hides the hint for the chat's person at its current pair of families. */
export function dismissModelHint(service, conversationId) {
  const conversation = service.store.getConversation(conversationId);
  refuseClosedChat(service, conversation);
  const to = currentFamily(service, conversation);
  const from = conversation.family;
  if (typeof from !== "string" || from === to) return { dismissed: false };
  service.longChats.modelHints.dismiss(
    conversationId,
    personOf(conversation),
    from,
    to,
    service.now?.() ?? Date.now(),
  );
  service.changed({ conversationId });
  return { dismissed: true };
}
