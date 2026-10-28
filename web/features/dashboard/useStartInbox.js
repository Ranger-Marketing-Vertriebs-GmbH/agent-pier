import { useEffect } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { publishInboxSummary } from "../inbox/inbox-store.js";

/**
 * The Inbox items for Needs you, or null until the live `inbox` topic sent its first
 * value. The topic pushes every change of the waiting set and reads the REST route
 * itself when the channel is down, so this hook requests nothing of its own. Its
 * summary keeps the sidebar and header counts current.
 */
export default function useStartInbox() {
  const { data } = useLiveTopic("inbox");
  useEffect(() => publishInboxSummary(data), [data]);
  if (!data) return null;
  return Array.isArray(data.items) ? data.items : [];
}
