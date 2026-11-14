// Every session_talk row of one chat, oldest first, whatever its op: the store's
// forConversation only returns the ops a chat shows as notes.
export const talkRows = (store, conversationId) =>
  store.db
    .prepare(
      "SELECT body FROM session_talk WHERE conversation_id=? ORDER BY created_at, rowid",
    )
    .all(conversationId)
    .map((row) => JSON.parse(row.body));
