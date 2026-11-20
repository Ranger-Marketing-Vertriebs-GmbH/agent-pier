import { useEffect, useState } from "react";
import api from "../../lib/api.js";
import { useLiveSignal } from "../../lib/live/useLiveTopic.js";

// With a search term results come by relevance unless `sort` is "newest"; without
// one they always come newest first.
export default function useProjectMemory({
  projectId,
  query,
  page,
  archived,
  sort = "relevance",
}) {
  const order = query ? sort : "newest";
  const requestKey = JSON.stringify([projectId, query, page, archived, order]);
  const [projects, setProjects] = useState([]),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [projectError, setProjectError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0),
    [loading, setLoading] = useState(false);
  // A write by a session, an agent or another tab: read the project and the page
  // again (memory.changed, pushed over the live channel).
  const changed = useLiveSignal(projectId ? `memory.changed:${projectId}` : null);
  useEffect(() => {
    if (changed) setRefreshVersion((value) => value + 1);
  }, [changed]);
  useEffect(() => {
    const controller = new AbortController();
    api("/memory/projects", "GET", undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setProjects(result.projects);
          setProjectError("");
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setProjectError(error.message);
      });
    return () => controller.abort();
  }, [refreshVersion]);
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const search = new URLSearchParams({
      q: query,
      page: String(page),
      archived: String(archived),
      ...(query && { sort: order }),
    });
    api(
      `/memory/projects/${encodeURIComponent(projectId)}/entries?${search}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted)
          setData({ key: requestKey, refreshVersion, result });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, query, page, archived, order, refreshVersion, requestKey]);
  return {
    projects,
    data: data?.key === requestKey ? data.result : null,
    completedData:
      data?.key === requestKey && data.refreshVersion === refreshVersion && !loading
        ? data.result
        : null,
    error: error || projectError,
    loading,
    refresh: () => setRefreshVersion((value) => value + 1),
  };
}
