import { useCallback, useEffect, useRef, useState } from "react";
import { createChatStream } from "../chat/chat-stream-transport.js";
import { assistantApi } from "./assistant-api.js";
import { connectionLost } from "./agent-offline.js";
import { nextStream } from "./stream-reply.js";

const settled = new Set(["completed", "failed", "cancelled"]);

/**
 * The live feed of one agent chat (/api/assistant-conversations/:id/stream): the
 * synced window goes to `onLive`, the reply streaming now is `stream`. The socket
 * resumes from the cursor of `initial` (the last known window), reconnects when the
 * page becomes visible or the device comes back online, and falls back to a few HTTP
 * reads (`?cursor=`) while it cannot connect. `refresh()` reads once over HTTP when
 * no socket delivers, so a sent message shows even then. `onReachable(false)` reports
 * a read that failed for want of a connection.
 */
export default function useAgentConversationStream(
  conversationId,
  { initial, onLive, onReachable },
) {
  const [stream, setStream] = useState(null);
  const [connection, setConnection] = useState("disconnected");
  const [error, setError] = useState("");
  const control = useRef(null);
  const callbacks = useRef({ onLive, onReachable });
  callbacks.current = { onLive, onReachable };
  const seed = useRef(initial);
  useEffect(() => {
    const runs = new Map();
    setStream(null);
    const dispose = createChatStream({
      initial: seed.current,
      url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/assistant-conversations/${encodeURIComponent(conversationId)}/stream`,
      read: async (signal, cursor) => {
        try {
          const value = await assistantApi.feed(conversationId, cursor, signal);
          callbacks.current.onReachable?.(true);
          return value;
        } catch (e) {
          if (!connectionLost(e)) throw e;
          // Offline the hint says it; no error message joins it.
          callbacks.current.onReachable?.(false);
          throw new Error("");
        }
      },
      onSnapshot: (live) => {
        seed.current = live;
        // Every turn is over: no reply streams any more.
        if (live.requests?.every((r) => settled.has(r.state))) {
          runs.clear();
          setStream(null);
        }
        callbacks.current.onReachable?.(true);
        callbacks.current.onLive(live);
      },
      onFrame: (frame) => {
        if (frame.type !== "stream") return;
        const next = nextStream(runs.get(frame.runId), frame);
        if (!next) return false;
        runs.delete(frame.runId);
        runs.set(frame.runId, next);
        setStream(next);
      },
      onConnection: setConnection,
      onError: setError,
      // A socket that fell behind resumes from its cursor at once.
      retryNow: (code) => code === 1013,
      network: window,
    });
    control.current = dispose;
    return () => {
      control.current = null;
      dispose();
    };
  }, [conversationId]);
  const refresh = useCallback(() => control.current?.refresh() ?? Promise.resolve(), []);
  return { stream, connection, error, refresh };
}
