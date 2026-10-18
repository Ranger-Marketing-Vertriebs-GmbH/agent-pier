import { useCallback, useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";
// Served from AgentPier itself: the CSP refuses an inlined data: worklet.
import workletUrl from "./pcm-capture-worklet.js?url&no-inline";
import {
  applyTranscript,
  dictated,
  draftText,
  settleDraft,
  startDraft,
} from "./dictation-text.js";

export const dictationAddress = (origin = globalThis.location) =>
  `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}/api/dictation/stream`;

/** Why this browser cannot dictate, or "" when it can (getUserMedia needs HTTPS). */
export function browserReason(scope = globalThis) {
  if (!scope.isSecureContext) return "insecure";
  if (!scope.navigator?.mediaDevices?.getUserMedia || !scope.AudioWorkletNode)
    return "unsupported";
  return "";
}

/** Whether the server can dictate and whether it sends right away; null loading. */
export function useDictationStatus() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api("/dictation")
        .then((next) => alive && setStatus(next))
        .catch(() => alive && setStatus({ available: false, reason: "unknown" }));
    load();
    // A key added in another tab counts once the owner comes back.
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
    };
  }, []);
  return status;
}

const mediaError = (error) =>
  error?.name === "NotAllowedError" || error?.name === "SecurityError"
    ? "denied"
    : error?.name === "NotFoundError" || error?.name === "OverconstrainedError"
      ? "noMicrophone"
      : "failed";

/**
 * One live dictation into a composer: microphone → 16 kHz PCM (audio worklet) →
 * AgentPier's dictation socket; transcripts replace their interim text in the
 * field through `onText`. `phase` is idle, connecting, recording or finishing.
 * `onFinished(text)` follows a dictation the owner stopped that added words.
 */
export default function useDictation({ text, onText, onFinished }) {
  const [phase, setPhase] = useState("idle");
  const [level, setLevel] = useState(0);
  // { kind: "status" | "error" | "ended", code, maxSeconds }
  const [notice, setNotice] = useState(null);
  const current = useRef({});
  const latest = useRef({ text, onText, onFinished });
  latest.current = { text, onText, onFinished };
  const release = useCallback(() => {
    const run = current.current;
    current.current = {};
    run.media?.getTracks().forEach((track) => track.stop());
    run.node?.port.close();
    run.context?.close().catch(() => {});
    if (run.socket && run.socket.readyState < 2) run.socket.close();
    setLevel(0);
    return run;
  }, []);
  const write = (draft) => {
    current.current.draft = draft;
    latest.current.onText(draft.written);
  };
  const finish = useCallback(
    (result) => {
      const run = release();
      setPhase("idle");
      setNotice(result);
      if (!run.draft) return;
      const settled = settleDraft(run.draft, latest.current.text);
      if (settled !== run.draft) latest.current.onText(settled.written);
      if (result.kind === "ended" && result.code === "stopped" && dictated(settled))
        latest.current.onFinished?.(draftText(settled));
    },
    [release],
  );
  const start = useCallback(async () => {
    if (current.current.run) return;
    const run = { run: true, queue: [], draft: startDraft(latest.current.text) };
    current.current = run;
    setPhase("connecting");
    setNotice({ kind: "status", code: "connecting" });
    const alive = () => current.current === run;
    try {
      run.media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (!alive()) return run.media.getTracks().forEach((track) => track.stop());
      run.context = new AudioContext();
      await run.context.audioWorklet.addModule(workletUrl);
      if (!alive()) return;
      run.node = new AudioWorkletNode(run.context, "agentpier-pcm");
      const silent = run.context.createGain();
      silent.gain.value = 0;
      run.context.createMediaStreamSource(run.media).connect(run.node);
      run.node.connect(silent).connect(run.context.destination);
    } catch (error) {
      if (alive()) finish({ kind: "error", code: mediaError(error) });
      return;
    }
    const socket = (run.socket = new WebSocket(dictationAddress()));
    run.node.port.onmessage = ({ data }) => {
      setLevel(Math.min(1, data.level * 3));
      if (socket.readyState === WebSocket.OPEN) socket.send(data.buffer);
      // Up to two seconds wait for the socket; the server keeps them until ready.
      else if (run.queue.length < 20) run.queue.push(data.buffer);
    };
    socket.onopen = () => {
      for (const buffer of run.queue) socket.send(buffer);
      run.queue = [];
    };
    socket.onmessage = (event) => {
      if (!alive() || typeof event.data !== "string") return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "ready") {
        run.maxSeconds = message.maxSeconds;
        setPhase((value) => (value === "connecting" ? "recording" : value));
        setNotice({ kind: "status", code: "recording" });
      } else if (message.type === "transcript")
        write(applyTranscript(current.current.draft, latest.current.text, message));
      else if (message.type === "ended")
        finish({ kind: "ended", code: message.reason, maxSeconds: run.maxSeconds });
      else if (message.type === "error") finish({ kind: "error", code: message.code });
    };
    socket.onclose = () => {
      if (alive()) finish({ kind: "error", code: "connection" });
    };
  }, [finish]);
  const stop = useCallback(() => {
    const run = current.current;
    if (!run.run) return;
    if (run.socket?.readyState !== WebSocket.OPEN || !run.maxSeconds)
      return finish({ kind: "ended", code: "stopped" });
    // The microphone goes off at once; the server still sends the last words.
    run.media?.getTracks().forEach((track) => track.stop());
    run.socket.send(JSON.stringify({ type: "stop" }));
    setPhase("finishing");
    setLevel(0);
    setNotice({ kind: "status", code: "finishing" });
  }, [finish]);
  // A hidden page (locked phone, switched app) ends the dictation.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") stop();
    };
    window.addEventListener("pagehide", stop);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", stop);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [stop]);
  useEffect(() => release, [release]);
  return { phase, level, notice, start, stop, dismiss: () => setNotice(null) };
}
