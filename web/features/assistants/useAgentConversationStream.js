import { useCallback, useEffect, useRef, useState } from "react";
import { createChatStream } from "../chat/chat-stream-transport.js";
import { assistantApi } from "./assistant-api.js";
import { connectionLost } from "./agent-offline.js";
import { nextStream } from "./stream-reply.js";
import { nextSteps } from "./run-steps.js";

const settled = new Set(["completed", "failed", "cancelled"]);

/**
 * The live feed of one agent chat (/api/assistant-conversations/:id/stream): the
 * synced window goes to `onLive`, the reply streaming now is `stream`. The socket
 * resumes from the cursor of `initial` (the last known window), reconnects when the
 * page becomes visible or the device comes back online, and falls back to a few HTTP
 * reads (`?cursor=`) while it cannot connect. `steps` holds the running turns' live
 * steps by run (run-steps.js). `refresh()` reads once over HTTP when
 * no socket delivers, so a sent message shows even then. `onReachable(false)` reports
 * a read that failed for want of a connection. `feed(id, cursor, signal)` replaces the
 * owner's HTTP read: a user's app reads her chat through /api/me (user-api.js).
 */
export default function useAgentConversationStream(
  conversationId,
  { initial, onLive, onReachable, feed = assistantApi.feed },
) {
  const [stream, setStream] = useState(null);
  const [steps, setSteps] = useState(() => new Map());
  const [connection, setConnection] = useState("disconnected");
  const [error, setError] = useState("");
  const control = useRef(null);
  const callbacks = useRef({ onLive, onReachable, feed });
  callbacks.current = { onLive, onReachable, feed };
  const seed = useRef(initial);
  useEffect(() => {
    const runs = new Map();
    let held = new Map();
    setStream(null);
    setSteps(held);
    const dispose = createChatStream({
      initial: seed.current,
      url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/assistant-conversations/${encodeURIComponent(conversationId)}/stream`,
      read: async (signal, cursor) => {
        try {
          const value = await callbacks.current.feed(conversationId, cursor, signal);
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
          if (held.size) setSteps((held = new Map()));
        }
        callbacks.current.onReachable?.(true);
        callbacks.current.onLive(live);
      },
      onFrame: (frame) => {
        const stepped = nextSteps(held, frame);
        if (stepped) {
          if (stepped !== held) setSteps((held = stepped));
          return;
        }
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
      // A logout or a conversation that is gone stops the feed until the page shows
      // again, the device comes online or the owner acts; a read that still finds
      // no login or no conversation keeps it stopped.
      halt: { codes: [1008], statuses: [401, 403, 404] },
      network: window,
    });
    control.current = dispose;
    return () => {
      control.current = null;
      dispose();
    };
  }, [conversationId]);
  const refresh = useCallback(() => control.current?.refresh() ?? Promise.resolve(), []);
  return { stream, steps, connection, error, refresh };
}
