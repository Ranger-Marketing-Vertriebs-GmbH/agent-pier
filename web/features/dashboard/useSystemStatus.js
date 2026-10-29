import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { usableStatus } from "./system-status-format.js";

// The live topic that carries a status route's answer (web/lib/live/live-topics.js).
const TOPICS = Object.freeze({
  "/system-status": "system.status",
  "/system-status/details": "system.status.details",
  "/system-status/cleanup/summary": "system.cleanup.summary",
});

/**
 * The system status of `path` (one of TOPICS): the server pushes it over the live
 * channel, sampling while this page is visible. `usable` turns an answer into data or
 * null; a pushed value it rejects counts as a failed read.
 */
export default function useSystemStatus(path, enabled = true, usable = usableStatus) {
  const live = useLiveTopic(enabled ? TOPICS[path] : null);
  const data = live.data === null ? null : usable(live.data);
  const error =
    live.data !== null && !data ? new Error("Unusable system status") : live.error;
  return { data, error: error || null };
}
