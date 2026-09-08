import { useEffect, useState } from "react";
import api from "../../lib/api.js";

export default function useProjectMemory({ projectId, query, page, archived }) {
  const requestKey = JSON.stringify([projectId, query, page, archived]);
  const [projects, setProjects] = useState([]),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [projectError, setProjectError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0),
    [loading, setLoading] = useState(false);
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
  }, [projectId, query, page, archived, refreshVersion, requestKey]);
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
