import { useEffect, useRef, useState } from "react";
import { requestCopy as copy } from "../../lib/i18n/messages/requests.js";
import { recentlyUsedElsewhere, settleNotice } from "../requests/request-interaction.js";
import useSessionRequests from "../requests/useSessionRequests.js";

// Hook-owned entries only: questions, legacy questions and plain tool approvals.
// Local startup/trust prompts are not hook invocations.
const hookOwned = (entry) =>
  entry.source === "claude" &&
  (entry.kind === "question" ||
    entry.presentation === "claudeLegacyQuestion" ||
    (entry.kind === "permission" && !entry.presentation));

// Claude's hook owns a question or tool approval until it receives a handoff.
// Opening xterm alone does not release it; leave the decision to Claude's
// native dialog. Only a focused tab showing the terminal releases requests, so
// an open terminal on another device cannot take one away from chat. The requests
// come from the pushed session requests (useSessionRequests); the handoff stays a
// REST call from this tab.
export default function useClaudeTerminalQuestions({ session, active, request }) {
  const [error, setError] = useState("");
  const enabled = Boolean(
    active &&
    session.tool === "claude" &&
    session.status === "running" &&
    session.nativeRequests?.enabled &&
    session.purpose !== "login" &&
    !session.pipeline?.headless,
  );
  const resource = useSessionRequests(enabled ? session.id : null);
  const latest = useRef(resource);
  latest.current = resource;
  const release = useRef(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const base = `/sessions/${encodeURIComponent(session.id)}/requests`;
    let running = false,
      again = false,
      timer;
    // Release each uncertain entry once; a repeated failure must not loop.
    const released = new Set();
    const visible = () => document.visibilityState !== "hidden" && document.hasFocus();
    const run = async () => {
      if (controller.signal.aborted || !visible()) return;
      if (running) {
        again = true;
        return;
      }
      const { data, update } = latest.current;
      if (!data) return;
      running = true;
      clearTimeout(timer);
      // Looked at again later: an entry in use elsewhere frees up as time passes,
      // and a failed handoff is tried again.
      let later = false;
      try {
        let unknown = false;
        for (const entry of data.requests) {
          if (controller.signal.aborted || !visible()) return;
          if (!hookOwned(entry)) continue;
          if (entry.status === "unknown") unknown = true;
          // An uncertain delivery is released too: the native side answers
          // stale if it already consumed the answer, otherwise Claude asks again.
          if (
            !["pending", "unknown"].includes(entry.status) ||
            (entry.status === "unknown" && released.has(entry.id)) ||
            recentlyUsedElsewhere(entry)
          ) {
            later ||= recentlyUsedElsewhere(entry);
            continue;
          }
          if (entry.status === "unknown") released.add(entry.id);
          // This tab shows the terminal; a "waiting in terminal" notice is moot.
          settleNotice(entry.id);
          const result = await request(
            `${base}/${encodeURIComponent(entry.id)}/handoff`,
            "POST",
            { expectedRevision: entry.revision },
            controller.signal,
          );
          // The answer is the list after the handoff; a later run must not offer
          // the released entry again before the next push arrives.
          if (!controller.signal.aborted && Array.isArray(result?.requests))
            update(result);
        }
        if (!controller.signal.aborted) setError(unknown ? copy.unknown : "");
      } catch (failure) {
        later = true;
        if (!controller.signal.aborted) setError(failure.message);
      } finally {
        running = false;
        if (again && !controller.signal.aborted) {
          again = false;
          void run();
        } else if (later && !controller.signal.aborted) timer = setTimeout(run, 1500);
      }
    };
    release.current = run;
    const wake = () => void run();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    void run();
    return () => {
      controller.abort();
      clearTimeout(timer);
      if (release.current === run) release.current = null;
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [enabled, session.id, request]);
  // Every new list, pushed or answered, is looked at again.
  useEffect(() => {
    void release.current?.();
  }, [resource.data]);
  return enabled ? error || resource.error : "";
}
