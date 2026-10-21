import { useCallback, useEffect, useRef, useState } from "react";
import { userApi } from "./user-api.js";
import { connectionLost } from "../assistants/agent-offline.js";

/**
 * The user's agents and her account view, kept current by her event stream
 * (/api/me/events): `agents` and `account` re-read the list and her account, every event goes to `subscribe`
 * listeners (chat lists, approvals). While AgentPier cannot be reached the last list
 * stays and `offline` is true.
 */
export default function useUserAgents() {
  const [agents, setAgents] = useState(null);
  const [me, setMe] = useState(null);
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(false);
  const listeners = useRef(new Set());
  const refresh = useCallback(async () => {
    try {
      const [list, account] = await Promise.all([userApi.agents(), userApi.me()]);
      setAgents(list);
      setMe(account);
      setError("");
      setOffline(false);
    } catch (e) {
      if (connectionLost(e)) setOffline(true);
      else setError(e.message);
    }
  }, []);
  useEffect(() => {
    refresh();
    const stream = new EventSource("/api/me/events");
    stream.onmessage = (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (["agents", "account", "connected"].includes(event.type)) refresh();
      for (const listener of [...listeners.current]) listener(event);
    };
    stream.onerror = () => refresh();
    const online = () => refresh();
    window.addEventListener("online", online);
    return () => {
      stream.close();
      window.removeEventListener("online", online);
    };
  }, [refresh]);
  const subscribe = useCallback((listener) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);
  return { agents, me, error, offline, refresh, subscribe };
}
