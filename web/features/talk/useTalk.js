import { useCallback, useEffect, useRef, useState } from "react";
import { getLanguage } from "../../lib/i18n/index.js";
import { browserReason, dictationAddress } from "../dictation/useDictation.js";
import { mediaError, openPcmCapture } from "../dictation/pcm-capture.js";
import { talkApi } from "./talk-api.js";
import { afterTurn, heardText, heardWords } from "./talk-state.js";

const noHeard = { finals: [], interim: "" };

/** Whether talk mode works here, or why not; null while loading. */
export function useTalkStatus(enabled) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    const load = () =>
      talkApi
        .status(controller.signal)
        .then(setStatus)
        .catch(() => {
          if (!controller.signal.aborted)
            setStatus({ available: false, reason: "unknown" });
        });
    load();
    // A key added in another tab counts once the owner comes back.
    window.addEventListener("focus", load);
    return () => {
      controller.abort();
      window.removeEventListener("focus", load);
    };
  }, [enabled]);
  const reason = browserReason() || (status && !status.available && status.reason);
  return { status, reason: reason || "" };
}

/**
 * Talk mode in an agent chat (AGENTPIER-291): listen through a talk dictation until the
 * speaker pauses, send the words as a normal chat turn (`deliver(text)`), read the
 * agent's new reply aloud, listen again. `turn` is the chat now: `{ active, replyId,
 * attemptId, attemptState }`. Phases: off, starting, listening, thinking, speaking,
 * paused. The AudioContext is created inside the tap and plays every reply, so iOS
 * lets it sound; the page hidden, Stop or the session cap end the session.
 */
export default function useTalk({ conversationId, enabled, turn, deliver }) {
  const [phase, setPhase] = useState("off");
  const [heard, setHeard] = useState("");
  // { source: "error" | "speak" | "ended" | "reason", code, minutes }
  const [notice, setNotice] = useState(null);
  const current = useRef(null);
  const latest = useRef({ turn, deliver });
  latest.current = { turn, deliver };

  const enter = (run, next) => {
    run.phase = next;
    setPhase(next);
  };
  // Ends the current turn's dictation, reading and playback; the session stays.
  const quiet = (run) => {
    const socket = run.socket;
    run.socket = null;
    if (socket && socket.readyState < 2) socket.close();
    run.reading?.abort();
    run.reading = null;
    try {
      run.source?.stop();
    } catch {}
    run.source = null;
    run.queue = [];
    setHeard("");
  };
  const end = useCallback((ended = null) => {
    const run = current.current;
    if (!run) return;
    current.current = null;
    quiet(run);
    clearTimeout(run.timer);
    run.capture?.close();
    run.context?.close().catch(() => {});
    if (run.session) talkApi.stop(run.session.id);
    setPhase("off");
    setNotice(ended);
  }, []);
  const fail = (run, notice) => {
    if (current.current !== run) return;
    end(notice);
  };
  // A problem within the session pauses it with the notice; a tap resumes.
  const pause = useCallback((notice = null) => {
    const run = current.current;
    if (!run) return;
    quiet(run);
    enter(run, "paused");
    setNotice(notice);
  }, []);

  const speak = async (run, messageId) => {
    enter(run, "speaking");
    const reading = (run.reading = new AbortController());
    let audio;
    try {
      const bytes = await talkApi.speech(
        conversationId,
        messageId,
        getLanguage() === "de" ? "de" : "en",
        reading.signal,
      );
      if (current.current !== run || run.reading !== reading) return;
      try {
        audio = await run.context.decodeAudioData(bytes);
      } catch {
        throw Object.assign(new Error("decode"), { code: "decode" });
      }
    } catch (error) {
      if (current.current !== run || run.reading !== reading) return;
      // A reply with nothing to say (only code) is skipped.
      if (error.code === "empty") return listen(run);
      return pause({ source: "speak", code: error.code || "failed" });
    }
    if (current.current !== run || run.reading !== reading) return;
    run.reading = null;
    const source = (run.source = run.context.createBufferSource());
    source.buffer = audio;
    source.connect(run.context.destination);
    source.onended = () => {
      if (current.current === run && run.source === source) {
        run.source = null;
        listen(run);
      }
    };
    source.start();
  };

  const submit = async (run, words) => {
    quiet(run);
    enter(run, "thinking");
    const { turn: now, deliver: send } = latest.current;
    run.baseline = { replyId: now.replyId, attemptId: now.attemptId };
    run.sent = false;
    const ok = await send(words);
    if (current.current !== run || run.phase !== "thinking") return;
    if (!ok) return pause({ source: "error", code: "sendFailed" });
    run.sent = true;
    follow(run);
  };

  // While thinking: speak the new reply once the agent is done.
  const follow = (run) => {
    if (run.phase !== "thinking" || !run.sent) return;
    const step = afterTurn(run.baseline, latest.current.turn);
    if (step.next === "speak") speak(run, step.messageId);
    else if (step.next === "listen") {
      setNotice({ source: "error", code: step.notice });
      listen(run);
    }
  };

  function listen(run) {
    if (current.current !== run) return;
    quiet(run);
    enter(run, "listening");
    let words = noHeard;
    const socket = (run.socket = new WebSocket(
      `${dictationAddress()}?talk=${encodeURIComponent(run.session.id)}`,
    ));
    const mine = () => current.current === run && run.socket === socket;
    socket.onopen = () => {
      for (const buffer of run.queue) socket.send(buffer);
      run.queue = [];
    };
    const send = () => {
      const text = heardText({ ...words, interim: "" });
      if (text) submit(run, text);
      return Boolean(text);
    };
    socket.onmessage = (event) => {
      if (!mine() || typeof event.data !== "string") return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "transcript") {
        words = heardWords(words, message);
        setHeard(heardText(words));
        if (message.final && message.speechFinal) send();
      } else if (message.type === "utteranceEnd") send();
      else if (message.type === "ended") {
        if (message.reason === "talkEnded")
          return fail(run, { source: "ended", code: "limit", minutes: run.minutes });
        if (message.reason === "replaced")
          return fail(run, { source: "error", code: "replaced" });
        // A turn at its length cap or without audio: send what was said, or listen on.
        if (!send()) listen(run);
      } else if (message.type === "error") {
        // The session ended on the server (its cap, another tab): talk mode ends.
        if (message.code === "talkEnded")
          return fail(run, { source: "ended", code: "limit", minutes: run.minutes });
        pause({ source: "error", code: message.code || "failed" });
      }
    };
    socket.onclose = () => {
      if (mine()) pause({ source: "error", code: "connection" });
    };
  }

  // Called straight from the tap: Safari only lets an AudioContext created and
  // resumed within the user gesture record and play, so it exists before any await.
  const start = useCallback(async () => {
    if (current.current) return;
    const run = { queue: [], phase: "starting" };
    try {
      run.context = new AudioContext();
    } catch {
      return setNotice({ source: "error", code: "failed" });
    }
    current.current = run;
    const resumed = run.context.resume().catch(() => {});
    // A silent sound inside the tap unlocks playback on iOS for the whole session.
    try {
      const unlock = run.context.createBufferSource();
      unlock.buffer = run.context.createBuffer(1, 1, run.context.sampleRate);
      unlock.connect(run.context.destination);
      unlock.start();
    } catch {}
    setNotice(null);
    enter(run, "starting");
    const alive = () => current.current === run;
    try {
      run.session = await talkApi.start(conversationId);
    } catch (error) {
      return fail(run, { source: "error", code: error.code || "failed" });
    }
    if (!alive()) return talkApi.stop(run.session.id);
    const lasts = Math.max(0, run.session.expiresAt - run.session.startedAt);
    run.minutes = Math.round(lasts / 60000);
    run.timer = setTimeout(
      () => fail(run, { source: "ended", code: "limit", minutes: run.minutes }),
      lasts,
    );
    try {
      run.capture = await openPcmCapture(run.context, {
        resumed,
        alive,
        onFrame: ({ buffer }) => {
          if (run.phase !== "listening" || !run.socket) return;
          if (run.socket.readyState === WebSocket.OPEN) run.socket.send(buffer);
          // Up to two seconds wait for the socket; the server keeps them until ready.
          else if (run.queue.length < 20) run.queue.push(buffer);
        },
      });
    } catch (error) {
      return fail(run, { source: "error", code: mediaError(error) });
    }
    if (!run.capture) return;
    // Started while the agent works: its reply is read first.
    if (latest.current.turn.active) {
      enter(run, "thinking");
      const now = latest.current.turn;
      run.baseline = { replyId: now.replyId, attemptId: now.attemptId };
      run.sent = true;
      follow(run);
    } else listen(run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const toggle = useCallback(() => {
    const run = current.current;
    if (!run || run.phase === "starting") return;
    if (run.phase === "paused") {
      setNotice(null);
      return listen(run);
    }
    pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pause]);

  // The agent's progress decides when a sent turn's reply is read.
  useEffect(() => {
    const run = current.current;
    if (run) follow(run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn.active, turn.replyId, turn.attemptId, turn.attemptState]);
  // A hidden page (locked phone, switched app) ends the session.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden")
        end(current.current ? { source: "ended", code: "hidden" } : null);
    };
    const left = () => end(null);
    window.addEventListener("pagehide", left);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", left);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [end]);
  // Another chat, a chat that turned read-only, or leaving it ends the session.
  useEffect(() => {
    if (!enabled) end(null);
  }, [enabled, end]);
  useEffect(() => () => end(null), [conversationId, end]);

  return {
    phase,
    heard,
    notice,
    start,
    stop: () => end(null),
    toggle,
    dismiss: () => setNotice(null),
    showReason: (code) => setNotice({ source: "reason", code }),
  };
}
