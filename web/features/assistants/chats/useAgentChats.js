import { useCallback, useEffect, useRef, useState } from "react";
import { assistantApi } from "../assistant-api.js";

/**
 * The chat routes of whoever views the list: the owner's (assistant-chats.js) or a
 * user's (/api/me, user-api.js passes its own). Each is
 * `{ list(agentId, archived), create(agentId), rename(id, title), archive(id),
 * restore(id), remove(id) }`.
 */
export const ownerChatApi = Object.freeze({
  list: assistantApi.chats,
  create: assistantApi.newChat,
  rename: assistantApi.renameChat,
  archive: assistantApi.archiveChat,
  restore: assistantApi.restoreChat,
  remove: assistantApi.deleteChat,
});

/**
 * One agent's chat list (AGENTPIER-181): the main chat first, then the most recently
 * active, and the archived ones apart (`showArchived` switches the sheet to them). `filter` keeps the chats this viewer
 * calls hers (the owner's own on a shared agent). It reads again whenever `version`
 * changes (an event naming the list) and after each action; `onChanged(chat, kind)`
 * reports an archived, restored or deleted chat, so caches can drop it.
 */
export default function useAgentChats(
  api,
  agentId,
  { version = 0, filter = null, onChanged } = {},
) {
  const [chats, setChats] = useState(null);
  const [archived, setArchived] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState("");
  const keep = useRef(filter);
  keep.current = filter;
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const read = useCallback(
    async (old) => {
      const result = await api.list(agentId, old);
      const list = Array.isArray(result) ? result : [];
      return keep.current ? list.filter(keep.current) : list;
    },
    [api, agentId],
  );
  // Both lists, so an open chat knows whether it is archived or gone.
  const load = useCallback(async () => {
    try {
      const [active, old] = await Promise.all([read(false), read(true)]);
      setChats(active);
      setArchived(old);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [read]);
  useEffect(() => {
    load();
  }, [load, version]);
  const act = useCallback(
    async (action, chat, kind) => {
      setError("");
      try {
        const result = await action();
        if (kind) changed.current?.(chat, kind);
        await load();
        return result;
      } catch (e) {
        setError(e.message);
        throw e;
      }
    },
    [load],
  );
  return {
    chats,
    archived,
    showArchived,
    setShowArchived,
    error,
    reload: load,
    create: () => act(() => api.create(agentId)),
    rename: (chat, title) => act(() => api.rename(chat.id, title)),
    archive: (chat) => act(() => api.archive(chat.id), chat, "archived"),
    restore: (chat) => act(() => api.restore(chat.id), chat, "restored"),
    remove: (chat) => act(() => api.remove(chat.id), chat, "deleted"),
  };
}
