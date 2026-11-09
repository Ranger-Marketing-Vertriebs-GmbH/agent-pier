import { createContext } from "react";

/**
 * What a chat lets its cards do (AssistantChat, UserChat): `check(cardId, body)` saves
 * a tick, `press(cardId, body, text)` records a press and sends its message as the
 * person's; `canSend` is false while the agent works or the chat cannot send. Without
 * a provider (the owner reading a user's chat) a card is read-only.
 */
export const CardActions = createContext(null);

/** An archived chat's cards: shown, never changed. */
export const closedCards = { canSend: false, check: null, press: null };

/**
 * The card actions of a chat over `api` (`checkCard`, `pressCard`) that send a press's
 * message with `deliver(text)`.
 */
export function cardActions(api, conversationId, { deliver, canSend }) {
  return {
    canSend,
    check: (cardId, body) => api.checkCard(conversationId, cardId, body),
    // A press whose message is not sent (deliver answers false) is forgotten again.
    press: async (cardId, body) => {
      const { text, at } = await api.pressCard(conversationId, cardId, body);
      const sent = await deliver(text);
      if (!sent) await api.unpressCard(conversationId, cardId, { at }).catch(() => {});
      return sent;
    },
  };
}
