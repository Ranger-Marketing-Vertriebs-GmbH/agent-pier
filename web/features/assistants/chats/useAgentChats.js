import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * reports an archived, restored or deleted chat, so caches can drop it. `live`
 * (`{data, error, refresh}` of a live topic whose value is the open list, as a
 * user's `me.chats:<agentId>`) replaces the open list's reads and `version`: its
 * pushes show at once, `refresh()` reads it after an action, and the archived list
 * is read again whenever the open chats change.
 */
export default function useAgentChats(
  api,
  agentId,
  { version = 0, filter = null, onChanged, live = null } = {},
) {
  const [readChats, setChats] = useState(null);
  const [archived, setArchived] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [failure, setError] = useState("");
  const keep = useRef(filter);
  keep.current = filter;
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const following = Boolean(live);
  const refreshLive = live?.refresh;
  const read = useCallback(
    async (old) => {
      const result = await api.list(agentId, old);
      const list = Array.isArray(result) ? result : [];
      return keep.current ? list.filter(keep.current) : list;
    },
    [api, agentId],
  );
  // Only the newest read of the archived list shows: an older answer never wins.
  const archivedRead = useRef(0);
  const readArchived = useCallback(async () => {
    const turn = ++archivedRead.current;
    const old = await read(true);
    if (turn === archivedRead.current) setArchived(old);
  }, [read]);
  // Both lists, so an open chat knows whether it is archived or gone.
  const load = useCallback(async () => {
    try {
      if (following) await Promise.all([refreshLive(), readArchived()]);
      else {
        const [active, old] = await Promise.all([read(false), read(true)]);
        setChats(active);
        setArchived(old);
      }
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [read, readArchived, following, refreshLive]);
  const pushed = live?.data;
  const chats = useMemo(() => {
    if (!following) return readChats;
    if (!Array.isArray(pushed)) return null;
    return keep.current ? pushed.filter(keep.current) : pushed;
  }, [following, readChats, pushed]);
  useEffect(() => {
    if (!following) load();
  }, [load, version, following]);
  // Followed: the archived list is read with the first open list and whenever the
  // open chats' ids change (a chat archived, restored, created or deleted).
  const ids = following && chats ? chats.map((chat) => chat.id).join(" ") : null;
  useEffect(() => {
    if (ids === null) return;
    readArchived().catch((e) => setError(e.message));
  }, [ids, readArchived]);
  const error = failure || (following ? live.error : "");
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
