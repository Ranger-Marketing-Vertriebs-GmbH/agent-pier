import { useCallback, useEffect, useRef, useState } from "react";
import { decodeFrame, streamAddress } from "./browser-frames.js";
import { assistantBrowserCopy as copy } from "../../../lib/i18n/messages/assistant-browser.js";

const idle = {
  status: "connecting",
  url: "",
  title: "",
  targetId: null,
  tabs: [],
  control: { held: false, mine: false },
};

/**
 * The live view of agent `id`'s browser: the server's state, the latest frame as an
 * object URL (only the newest is kept; nothing is stored) and the commands. The
 * socket reconnects after a drop while the view is open.
 */
export default function useBrowserStream(id, { preview = false, enabled = true } = {}) {
  const [state, setState] = useState(idle);
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  const socket = useRef(null);
  useEffect(() => {
    // Another agent's view starts from nothing, never with the last one's picture.
    setState(idle);
    setError("");
    if (!enabled || !id) return undefined;
    let alive = true,
      retry,
      current = "";
    const connect = () => {
      const ws = new WebSocket(streamAddress(id, preview));
      ws.binaryType = "arraybuffer";
      socket.current = ws;
      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (message.type === "state") setState({ ...idle, ...message.state });
          if (message.type === "error")
            setError(copy.liveErrors[message.code] || message.message || "");
          return;
        }
        const frame = decodeFrame(event.data);
        if (!frame) return;
        const next = URL.createObjectURL(new Blob([frame.jpeg], { type: "image/jpeg" }));
        if (current) URL.revokeObjectURL(current);
        current = next;
        setImage(next);
      };
      ws.onclose = (event) => {
        if (socket.current === ws) socket.current = null;
        // 1008: the login ended or the request was refused; reconnecting cannot help.
        if (event.code === 1008) {
          alive = false;
          setError(copy.liveEnded);
          return;
        }
        // 4000: still admitted, now to watch only (or to drive): reconnect at once.
        const wait = event.code === 4000 ? 0 : event.code === 1013 ? 10000 : 2000;
        if (alive) retry = setTimeout(connect, wait);
      };
    };
    connect();
    return () => {
      alive = false;
      clearTimeout(retry);
      socket.current?.close();
      socket.current = null;
      if (current) URL.revokeObjectURL(current);
      setImage("");
    };
  }, [id, preview, enabled]);
  const send = useCallback((command) => {
    if (socket.current?.readyState !== WebSocket.OPEN) {
      setError(copy.liveNotConnected);
      return;
    }
    setError("");
    socket.current.send(JSON.stringify(command));
  }, []);
  // Owner input while holding control: never an error notice per event.
  const input = useCallback((command) => {
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify(command));
  }, []);
  return {
    state,
    image,
    error,
    select: (targetId) => send({ type: "select", targetId }),
    follow: () => send({ type: "follow" }),
    start: () => send({ type: "start" }),
    stop: () => send({ type: "stop" }),
    take: ({ move = false } = {}) =>
      send({ type: "take", ...(move ? { move: true } : {}) }),
    handBack: () => send({ type: "handBack" }),
    input,
  };
}
