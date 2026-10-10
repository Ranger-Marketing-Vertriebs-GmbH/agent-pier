import "./assistants.css";
import "./assistant-chat.css";
import "./assistant-settings.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assistantApi } from "./assistant-api.js";
import { sharedDrafts } from "./useAssistants.js";
// Lazily loaded owner of the assistant data and the event stream. It renders nothing
// and publishes into the always-mounted gate, so toggling it never remounts the app.
export default function AssistantsHost({ publishState, publishEvents }) {
  const [data, setData] = useState({ assistants: [], conversations: [], models: [] });
  const [runtime, setRuntime] = useState({ availability: "disabled", sync: "stale" });
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(true);
  const [lastEvent, setLastEvent] = useState(null);
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
          policies: next.policies || {},
          teamSettings: next.teamSettings,
        });
        setRuntime(status);
        setError("");
      }
    } catch (e) {
      if (alive.current) setError(e.message);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    refresh();
    const stream = new EventSource("/api/assistant-events");
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.onmessage = (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      setLastEvent(event);
      if (event.type === "runtime") setRuntime(event);
      if (["change", "connected"].includes(event.type)) refresh();
    };
    return () => {
      alive.current = false;
      stream.close();
    };
  }, [refresh]);
  const value = useMemo(
    () => ({ ...data, runtime, error, connected, drafts: sharedDrafts, refresh }),
    [data, runtime, error, connected, refresh],
  );
  const events = useMemo(() => ({ lastEvent }), [lastEvent]);
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
