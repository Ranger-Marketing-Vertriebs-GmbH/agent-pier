import "./assistants.css";
import "./assistant-sidebar.css";
import "./assistant-chat.css";
import "./assistant-teams.css";
import "./assistant-settings.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "../../lib/api.js";
import { liveClient } from "../../lib/live/live-client.js";
import { startLiveTopic } from "../../lib/live/live-topic-reader.js";
import { sharedDrafts } from "./useAssistants.js";
import { AgentHistoryCache, connectionLost } from "./agent-offline.js";
import { readAgentList, saveAgentList } from "./agent-list-cache.js";
// How long the host waits before it keeps a changed list on the device.
const SAVE_DELAY_MS = 1000;
const none = [];
const nothing = {};
// The host state from a list read or a list sync; missing sections stay stable.
// `loaded` tells an empty first list apart from the empty state before it arrives.
const toData = (next) => ({
  loaded: true,
  assistants: next.assistants || none,
  conversations: next.conversations || none,
  deletions: next.deletions || none,
  models: next.models || none,
  teams: next.teams || none,
  members: next.members || none,
  requests: next.requests || none,
  groups: next.groups || none,
  agentGroups: next.agentGroups || none,
  agentOrder: next.agentOrder || none,
  policies: next.policies || nothing,
  teamSettings: next.teamSettings,
  activity: next.activity || nothing,
});
// Lazily loaded owner of the agent data: the live `agent.list` topic (the list with
// the runtime status). It renders nothing and publishes into the always-mounted
// gate, so toggling it never remounts the app.
export default function AssistantsHost({ publishState }) {
  // The list this login last saw on this device (agent-list-cache.js): shown, as last
  // known, until AgentPier answers, so a page opened without a connection lists it.
  const [kept] = useState(() => readAgentList());
  const [data, setData] = useState(() =>
    kept
      ? toData(kept.list)
      : { assistants: [], conversations: [], models: [], activity: {} },
  );
  const [runtime, setRuntime] = useState(
    () => kept?.list.runtime || { availability: "disabled", sync: "stale" },
  );
  // True while what is shown came from the device, not yet from AgentPier.
  const [restored, setRestored] = useState(Boolean(kept));
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
  // The topic's reader: its refresh() reads the list over REST after the owner's own
  // writes; a push that arrives meanwhile is newer and stays.
  const reader = useRef(null);
  const refresh = useCallback(
    () => reader.current?.refresh() ?? Promise.resolve(null),
    [],
  );
  useEffect(() => {
    let alive = true,
      // The list last shown, and whether the live channel was connected.
      shown = null,
      linked = false,
      // The list to keep on the device, written once it rested for SAVE_DELAY_MS.
      unsaved = null,
      timer = null;
    const save = () => {
      clearTimeout(timer);
      timer = null;
      if (alive && unsaved) saveAgentList(unsaved);
      unsaved = null;
    };
    // A REST read of the list or the runtime (the fallback, `stale`, refresh()) also
    // tells whether AgentPier is there; the shown agents stay until one succeeds.
    const read = async (path, signal) => {
      try {
        const value = await api(path, "GET", undefined, signal);
        if (alive) setReachable(true);
        return value;
      } catch (e) {
        if (alive && !signal?.aborted) {
          if (connectionLost(e)) setReachable(false);
          else setError(e.message);
        }
        throw e;
      }
    };
    const client = liveClient();
    const started = startLiveTopic({
      topicId: "agent.list",
      client,
      read,
      report: ({ data, connected: live }) => {
        if (!alive) return;
        // Disconnected once the channel gave up for now and the list is polled
        // (LiveClient fallback), not for each reconnect that follows a dropped socket.
        setConnected(live || !client.status().fallback);
        // A new connection reaches AgentPier.
        if (live && !linked) setReachable(true);
        linked = live;
        if (!data || data === shown) return;
        shown = data;
        unsaved = data;
        timer ??= setTimeout(save, SAVE_DELAY_MS);
        setRestored(false);
        const { runtime: status, ...list } = data;
        setData((old) => {
          const next = toData(list);
          // Unchanged sections keep their identity, and so does an unchanged list.
          return Object.keys(next).every((key) => next[key] === old[key]) ? old : next;
        });
        if (status) setRuntime((old) => (old === status ? old : status));
        setError("");
        setReachable(true);
      },
    });
    reader.current = started;
    const offline = () => setReachable(false);
    // Back online: one read tells whether AgentPier is there again, also while the
    // channel's socket outlived the outage and pushes nothing new.
    const online = () => started.refresh();
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    // A page leaving or hidden (a phone app sent away) keeps what it shows now.
    const hidden = () => document.hidden && save();
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      // Unmounted by a logout or agents switched off: nothing more is written.
      alive = false;
      clearTimeout(timer);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", hidden);
      if (reader.current === started) reader.current = null;
      started.stop();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, []);
  const value = useMemo(
    () => ({
      ...data,
      runtime,
      error,
      connected,
      offline: !reachable,
      restored,
      histories,
      drafts: sharedDrafts,
      refresh,
    }),
    [data, runtime, error, connected, reachable, restored, histories, refresh],
  );
  useEffect(() => publishState(value), [value, publishState]);
  useEffect(() => () => publishState(null), [publishState]);
  return null;
}
