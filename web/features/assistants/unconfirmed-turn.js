import { useEffect, useRef, useState } from "react";
// A turn whose sessions.send acknowledgement was lost is uncertain but may still run;
// the server confirms it from the Gateway's evidence (run-confirmation.js). Until the
// run has been quiet this long the chat waits calmly instead of offering a restart.
// Measured on the browser's clock only: from when this chat first saw the turn
// waiting, or from its latest progress.
export const quietAfterMs = 120000;

const confirmable = (attempt) =>
  attempt?.state === "uncertain" && attempt.unconfirmed === true && !attempt.reviewedAt;

/** Whether the chat still waits for `attempt`, quiet since `since`, at `now`. */
export function awaitingConfirmation(attempt, since, now, quietMs = quietAfterMs) {
  return confirmable(attempt) && now - since < quietMs;
}

/**
 * `progress` changes whenever the run shows output (streamed text, new messages);
 * each change while the turn waits restarts the quiet period.
 */
export default function useAwaitingConfirmation(attempt, progress) {
  const waiting = confirmable(attempt);
  const since = useRef({ id: null, at: 0 });
  const seen = useRef(progress);
  const [now, setNow] = useState(() => Date.now());
  // The first sight of this attempt waiting starts its quiet period.
  if (waiting && since.current.id !== attempt.id)
    since.current = { id: attempt.id, at: Date.now() };
  useEffect(() => {
    if (seen.current === progress) return;
    seen.current = progress;
    if (!waiting) return;
    since.current = { ...since.current, at: Date.now() };
    setNow(since.current.at);
  }, [progress, waiting]);
  useEffect(() => {
    if (!waiting) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [waiting]);
  return (
    waiting &&
    awaitingConfirmation(attempt, since.current.at, Math.max(now, since.current.at))
  );
}
