import { useEffect, useState } from "react";
import { requestCopy as copy } from "../../lib/i18n/messages/requests.js";
import { recentlyUsedElsewhere, settleNotice } from "../requests/request-interaction.js";

// Claude's hook owns a question or tool approval until it receives a handoff.
// Opening xterm alone does not release it; leave the decision to Claude's
// native dialog. Only a focused tab showing the terminal releases requests, so
// an open terminal on another device cannot take one away from chat.
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
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const base = `/sessions/${encodeURIComponent(session.id)}/requests`;
    let timer,
      reading = false;
    // Release each uncertain entry once; a repeated failure must not loop.
    const released = new Set();
    const visible = () => document.visibilityState !== "hidden" && document.hasFocus();
    const read = async () => {
      if (reading || !visible() || controller.signal.aborted) return;
      reading = true;
      try {
        const result = await request(base, "GET", undefined, controller.signal);
        let unknown = false;
        for (const entry of result.requests) {
          if (controller.signal.aborted || !visible()) return;
          // Hook-owned entries only: questions, legacy questions and plain tool
          // approvals. Local startup/trust prompts are not hook invocations.
          if (
            entry.source !== "claude" ||
            !(
              entry.kind === "question" ||
              entry.presentation === "claudeLegacyQuestion" ||
              (entry.kind === "permission" && !entry.presentation)
            )
          )
            continue;
          if (entry.status === "unknown") unknown = true;
          // An uncertain delivery is released too: the native side answers
          // stale if it already consumed the answer, otherwise Claude asks again.
          if (
            !["pending", "unknown"].includes(entry.status) ||
            (entry.status === "unknown" && released.has(entry.id)) ||
            recentlyUsedElsewhere(entry)
          )
            continue;
          if (entry.status === "unknown") released.add(entry.id);
          // This tab shows the terminal; a "waiting in terminal" notice is moot.
          settleNotice(entry.id);
          await request(
            `${base}/${encodeURIComponent(entry.id)}/handoff`,
            "POST",
            { expectedRevision: entry.revision },
            controller.signal,
          );
        }
        if (!controller.signal.aborted) setError(unknown ? copy.unknown : "");
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      } finally {
        reading = false;
        if (!controller.signal.aborted) timer = setTimeout(read, 1500);
      }
    };
    const wake = () => {
      clearTimeout(timer);
      void read();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [enabled, session.id, request]);
  return enabled ? error : "";
}
