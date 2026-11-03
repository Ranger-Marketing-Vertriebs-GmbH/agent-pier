import { useEffect } from "react";
import { assistantApi } from "../assistant-api.js";

/**
 * The owner's "Start fresh chats" choice while the drafted model differs from the
 * saved one: the draft field `freshChats` is null until the server's preview (the
 * family rule) answers with the default, and goes back to null when the model does.
 * A failed preview defaults to on. A member that follows its lead picks no model here.
 */
export default function useModelSwitchChoice(draft, assistantId) {
  const { connectionId, modelId, followLead } = draft.values;
  const { set } = draft;
  const changed =
    !followLead &&
    !!modelId &&
    (connectionId !== draft.base.connectionId || modelId !== draft.base.modelId);
  useEffect(() => {
    set("freshChats", null);
    if (!changed) return undefined;
    const controller = new AbortController();
    assistantApi
      .modelSwitchPreview(assistantId, { connectionId, modelId }, controller.signal)
      .then((preview) => {
        // A late answer for a model the draft has left since sets nothing.
        if (!controller.signal.aborted)
          set("freshChats", preview?.freshChatsDefault !== false);
      })
      .catch(() => {
        if (!controller.signal.aborted) set("freshChats", true);
      });
    return () => controller.abort();
  }, [assistantId, changed, connectionId, modelId, set]);
}
