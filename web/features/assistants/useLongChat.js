import { useCallback, useRef, useState } from "react";

/**
 * The long-chat hint's actions (server long-chats.js) for one chat: `summarise` asks
 * first (`confirming`, SummariseConfirm.jsx), and only `confirmSummarise` has OpenClaw
 * summarise its history, as the summary cannot be undone; `cancelSummarise` sends
 * nothing (AGENTPIER-295). `dismiss` hides the hint until the chat grew clearly
 * further. `api` names the person's routes ({ compact, dismissLongChat }); a refusal
 * shows through `onError`. One action at a time: a double click sends once.
 */
export default function useLongChat(api, conversationId, { refresh, onError }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const pending = useRef(false);
  const act = useCallback(
    async (call) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      onError("");
      try {
        await call(conversationId);
      } catch (e) {
        onError(e.message);
      } finally {
        pending.current = false;
        setBusy(false);
      }
      await refresh?.();
    },
    [conversationId, refresh, onError],
  );
  return {
    busy,
    confirming,
    summarise: () => setConfirming(true),
    // The dialog closes at once: the chat shows the summary running, not the dialog.
    confirmSummarise: () => {
      setConfirming(false);
      act(api.compact);
    },
    cancelSummarise: () => setConfirming(false),
    dismiss: () => act(api.dismissLongChat),
  };
}
