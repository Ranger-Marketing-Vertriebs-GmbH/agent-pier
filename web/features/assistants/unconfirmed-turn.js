import { useEffect, useRef, useState } from "react";
// A turn whose sessions.send acknowledgement was lost is uncertain but may still run;
// the server confirms it from the Gateway's evidence (run-confirmation.js). Until the
// run has been quiet this long the chat waits calmly instead of offering a restart.
export const quietAfterMs = 120000;

const confirmable = (attempt) =>
  attempt?.state === "uncertain" && attempt.unconfirmed === true && !attempt.reviewedAt;

/** Whether the chat still waits for the confirmation of `attempt` at `now`. */
export function awaitingConfirmation(attempt, lastActivity, now, quietMs = quietAfterMs) {
  if (!confirmable(attempt)) return false;
  const since = Math.max(Date.parse(attempt.createdAt) || 0, lastActivity || 0);
  return now - since < quietMs;
}

/**
 * `progress` changes whenever the run shows output (streamed text, new messages);
 * each change restarts the quiet period.
 */
export default function useAwaitingConfirmation(attempt, progress) {
  const last = useRef(0);
  const seen = useRef(progress);
  const [now, setNow] = useState(() => Date.now());
  const waiting = confirmable(attempt);
  // Only progress while the turn waits counts; loading the chat is none.
  useEffect(() => {
    if (seen.current === progress) return;
    seen.current = progress;
    if (!waiting) return;
    last.current = Date.now();
    setNow(last.current);
  }, [progress, waiting]);
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [waiting]);
  return awaitingConfirmation(attempt, last.current, now);
}
