import { useCallback, useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";
import { liveClient } from "../../lib/live/live-client.js";
import { startLiveTopic } from "../../lib/live/live-topic-reader.js";
import { connectionLost } from "../assistants/agent-offline.js";

/**
 * The user's agents and her account view, pushed on her live topics `me.agents` and
 * `me.account` (server live-me-topics.js); without the live channel each topic polls
 * its /api/me route. While AgentPier cannot be reached the last list stays and
 * `offline` is true. `refresh()` reads both again (after her own writes); a push that
 * arrives meanwhile is newer and stays.
 */
export default function useUserAgents() {
  const [agents, setAgents] = useState(null);
  const [me, setMe] = useState(null);
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(false);
  const readers = useRef([]);
  const refresh = useCallback(
    () => Promise.all(readers.current.map((reader) => reader.refresh())),
    [],
  );
  useEffect(() => {
    let alive = true,
      // Whether the live channel was connected at the last report.
      linked = false;
    // A REST read (the fallback, `stale`, refresh()) also tells whether AgentPier is
    // there; the shown list stays until one succeeds.
    const read = async (path, signal) => {
      try {
        const value = await api(path, "GET", undefined, signal);
        if (alive) setOffline(false);
        return value;
      } catch (e) {
        if (alive && !signal?.aborted) {
          if (connectionLost(e)) setOffline(true);
          else setError(e.message);
        }
        throw e;
      }
    };
    const client = liveClient();
    const follow = (topicId, set) => {
      // The value last shown: a report of the same value (a status change) says
      // nothing about whether AgentPier is there.
      let shown = null;
      return startLiveTopic({
        topicId,
        client,
        read,
        report: ({ data, connected }) => {
          if (!alive) return;
          // A new connection reaches AgentPier.
          if (connected && !linked) setOffline(false);
          linked = connected;
          if (!data || data === shown) return;
          shown = data;
          set(data);
          setError("");
          setOffline(false);
        },
      });
    };
    const started = [follow("me.agents", setAgents), follow("me.account", setMe)];
    readers.current = started;
    const lost = () => setOffline(true);
    // Back online: one read tells whether AgentPier is there again, also while the
    // channel's socket outlived the outage and pushes nothing new.
    const online = () => started.forEach((reader) => reader.refresh());
    window.addEventListener("offline", lost);
    window.addEventListener("online", online);
    return () => {
      alive = false;
      if (readers.current === started) readers.current = [];
      for (const reader of started) reader.stop();
      window.removeEventListener("offline", lost);
      window.removeEventListener("online", online);
    };
  }, []);
  return { agents, me, error, offline, refresh };
}
