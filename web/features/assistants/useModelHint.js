import { useCallback, useRef, useState } from "react";

/**
 * The actions of the hint in an older chat that began on another model (server
 * model-hints.js) for one chat: `newChat` starts a fresh chat with the same agent and
 * has `open(chat)` show it, `dismiss` hides the hint for this person. `api` names the
 * person's routes ({ newChat(agentId), dismissModelHint(conversationId) }); a refusal
 * shows through `onError`. One action at a time: a double click sends once.
 */
export default function useModelHint(
  api,
  conversationId,
  agentId,
  { refresh, onError, open },
) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const act = useCallback(
    async (call) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      onError("");
      try {
        await call();
      } catch (e) {
        onError(e.message);
      } finally {
        pending.current = false;
        setBusy(false);
      }
    },
    [onError],
  );
  return {
    busy,
    newChat: () => act(async () => open(await api.newChat(agentId))),
    dismiss: () =>
      act(async () => {
        await api.dismissModelHint(conversationId);
        await refresh?.();
      }),
  };
}

/**
 * Where New chat leads for the owner: the new chat joins the agent list first, so its
 * page finds it.
 */
export const openOwnerChat = (navigate, assistantId, reload) => async (chat) => {
  await reload();
  navigate({ view: "agents", assistantId, conversationId: chat.id });
};
