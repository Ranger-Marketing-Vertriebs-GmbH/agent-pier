import { useEffect, useState } from "react";
import { requestCopy as copy } from "../../lib/i18n/messages/requests.js";

// Claude's hook owns the question until it receives a handoff. Opening xterm
// alone does not release it; leave the answer to Claude's native dialog.
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
    const visible = () => document.visibilityState !== "hidden";
    const read = async () => {
      if (reading || !visible() || controller.signal.aborted) return;
      reading = true;
      try {
        const result = await request(base, "GET", undefined, controller.signal);
        let unknown = false;
        for (const entry of result.requests) {
          if (controller.signal.aborted || !visible()) return;
          if (
            entry.source !== "claude" ||
            (entry.kind !== "question" && entry.presentation !== "claudeLegacyQuestion")
          )
            continue;
          if (entry.status === "unknown") unknown = true;
          if (entry.status !== "pending") continue;
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
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [enabled, session.id, request]);
  return enabled ? error : "";
}
