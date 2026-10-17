import "./assistants.css";
import "./assistant-sidebar.css";
import "./assistant-chat.css";
import "./assistant-teams.css";
import "./assistant-settings.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assistantApi } from "./assistant-api.js";
import { sharedDrafts } from "./useAssistants.js";
import { AgentHistoryCache, connectionLost } from "./agent-offline.js";
// Lazily loaded owner of the assistant data and the event stream. It renders nothing
// and publishes into the always-mounted gate, so toggling it never remounts the app.
export default function AssistantsHost({ publishState, publishEvents }) {
  const [data, setData] = useState({
    assistants: [],
    conversations: [],
    models: [],
    activity: {},
  });
  const [runtime, setRuntime] = useState({ availability: "disabled", sync: "stale" });
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(true);
  // False while AgentPier cannot be reached: the last known agents and chats stay.
  const [reachable, setReachable] = useState(true);
  // Lives with this host, so a logout (which unmounts the app) also forgets it.
  const [histories] = useState(() => new AgentHistoryCache());
  const listeners = useRef(new Set());
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const [next, status] = await Promise.all([
        assistantApi.list(),
        assistantApi.runtime(),
      ]);
      if (alive.current) {
        setData({
          assistants: next.assistants || [],
          conversations: next.conversations || [],
          models: next.models || [],
          teams: next.teams || [],
          members: next.members || [],
          requests: next.requests || [],
          policies: next.policies || {},
          teamSettings: next.teamSettings,
          activity: next.activity || {},
        });
        setRuntime(status);
        setError("");
        setReachable(true);
      }
    } catch (e) {
      if (!alive.current) return;
      if (connectionLost(e)) setReachable(false);
      else setError(e.message);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    refresh();
    let stream,
      timer,
      attempts = 0;
    // 2 is EventSource.CLOSED.
    const closed = () => stream?.readyState === 2;
    const open = () => {
      clearTimeout(timer);
      stream?.close();
      stream = new EventSource("/api/assistant-events");
      stream.onopen = () => {
        attempts = 0;
        setConnected(true);
      };
      stream.onerror = () => {
        setConnected(false);
        // Each failed attempt also tries the list, which tells whether AgentPier is
        // there at all; the shown agents stay until a read succeeds.
        refresh();
        // A refused stream (an error page, the service restarting) is closed for good:
        // open a new one with backoff instead of waiting for a reload.
        if (closed()) timer = setTimeout(open, Math.min(1000 * 2 ** attempts++, 30000));
      };
      stream.onmessage = (message) => {
        let event;
        try {
          event = JSON.parse(message.data);
        } catch {
          return;
        }
        for (const listener of [...listeners.current]) listener(event);
        if (event.type === "runtime") setRuntime(event);
        if (["change", "connected"].includes(event.type)) refresh();
      };
    };
    open();
    const offline = () => setReachable(false);
    // Back online or in the foreground again: check now rather than after the backoff.
    const resume = () => {
      if (document.hidden) return;
      refresh();
      if (closed()) {
        attempts = 0;
        open();
      }
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      alive.current = false;
      clearTimeout(timer);
      stream.close();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [refresh]);
  const value = useMemo(
    () => ({
      ...data,
      runtime,
      error,
      connected,
      offline: !reachable,
      histories,
      drafts: sharedDrafts,
      refresh,
    }),
    [data, runtime, error, connected, reachable, histories, refresh],
  );
  const events = useMemo(
    () => ({
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [],
  );
  useEffect(() => publishState(value), [value, publishState]);
  useEffect(() => publishEvents(events), [events, publishEvents]);
  useEffect(
    () => () => {
      publishState(null);
      publishEvents(null);
    },
    [publishState, publishEvents],
  );
  return null;
}
