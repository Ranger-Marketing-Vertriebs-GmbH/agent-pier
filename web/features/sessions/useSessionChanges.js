import useLiveTopic from "../../lib/live/useLiveTopic.js";

/**
 * The changes summary of a session (`null` follows nothing), pushed on the
 * `session.changes` topic: its workspaces with their diff base and counts.
 * `refresh()` reads the summary again, for a diff read that found its workspace gone.
 * @returns {{ summary: import("../../../server/features/changes/session-changes.js").ChangesSummary|null,
 *   loading: boolean, error: string, refresh: () => Promise<unknown> }}
 */
export default function useSessionChanges(sessionId) {
  const topic = useLiveTopic(sessionId ? `session.changes:${sessionId}` : null);
  return {
    summary: topic.data ?? null,
    loading: topic.loading,
    error: topic.error,
    refresh: topic.refresh,
  };
}
