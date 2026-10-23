import "./assistants.css";
import "./assistant-sidebar.css";
import "./assistant-chat.css";
import "./assistant-teams.css";
import "./assistant-settings.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assistantApi } from "./assistant-api.js";
import { sharedDrafts } from "./useAssistants.js";
import { AgentHistoryCache, connectionLost } from "./agent-offline.js";
import { applyListSync } from "./agent-list-sync.js";
const none = [];
const nothing = {};
// The host state from a list read or a list sync; missing sections stay stable.
const toData = (next) => ({
  assistants: next.assistants || none,
  conversations: next.conversations || none,
  models: next.models || none,
  teams: next.teams || none,
  members: next.members || none,
  requests: next.requests || none,
  policies: next.policies || nothing,
  teamSettings: next.teamSettings,
  activity: next.activity || nothing,
});
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
  const listed = useRef(none);
  useEffect(() => {
    histories.forgetVanished(listed.current, data.conversations);
    listed.current = data.conversations;
  }, [histories, data.conversations]);
  const listeners = useRef(new Set());
  const alive = useRef(true);
  // Counts applied list syncs: a read that a sync overtook is not shown.
  const syncs = useRef(0);
  const refresh = useCallback(async () => {
    const seen = syncs.current;
    try {
      const [next, status] = await Promise.all([
        assistantApi.list(),
        assistantApi.runtime(),
      ]);
      if (alive.current) {
        // A sync that arrived meanwhile is at least as new; it stays.
        if (syncs.current === seen) {
          setData(toData(next));
          setRuntime(status);
        }
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
    // The first list comes at once, also when the stream is slow to connect.
    refresh();
    let stream,
      timer,
      attempts = 0,
      // The list as last synced ({state, list, sections}): its cursor resumes.
      synced = null,
      // Whether this stream sends the list as diffs; an older server only says
      // "change", and the list is read again for each.
      feed = false;
    // 2 is EventSource.CLOSED.
    const closed = () => stream?.readyState === 2;
    const open = () => {
      clearTimeout(timer);
      stream?.close();
      feed = false;
      const cursor = synced?.state.sync.cursor;
      stream = new EventSource(
        `/api/assistant-events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
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
        // The browser status and a pending restart come only with the list; the
        // event keeps the last ones.
        if (event.type === "runtime")
          setRuntime((old) => ({
            browser: old.browser,
            pendingRestart: old.pendingRestart,
            ...event,
          }));
        if (event.type === "connected") feed = !!event.list;
        if (event.type === "sync") applySync(event.data);
        // Without the feed, or when it could not read the list: read it whole.
        if (
          event.type === "list-error" ||
          (!feed && ["change", "connected"].includes(event.type))
        )
          refresh();
      };
    };
    const applySync = (data) => {
      try {
        synced = applyListSync(synced, data);
      } catch {
        // Another base or a malformed frame: start over with the whole list.
        synced = null;
        open();
        return;
      }
      syncs.current++;
      const { runtime: status, ...list } = synced.list;
      setData((old) => {
        const next = toData(list);
        // Unchanged sections keep their identity, and so does an unchanged list.
        return Object.keys(next).every((key) => next[key] === old[key]) ? old : next;
      });
      if (status) setRuntime((old) => (old === status ? old : status));
      setError("");
      setReachable(true);
    };
    open();
    const offline = () => setReachable(false);
    // Back online or in the foreground again: check now rather than after the backoff.
    const resume = () => {
      if (document.hidden) return;
      // An open feed keeps the list current; otherwise read it now.
      if (!feed || closed()) refresh();
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
