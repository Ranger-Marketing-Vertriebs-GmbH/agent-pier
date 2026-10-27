import { useEffect, useState, useRef } from "react";
import { startVisiblePolling } from "../../lib/visible-polling.js";
export default function useAgentBusMessages({ request, project, page, onPage }) {
  const pageCallback = useRef(onPage);
  pageCallback.current = onPage;
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  useEffect(() => {
    setData(null);
    setError("");
    async function read(signal) {
      try {
        const result = await request(
          `/agentbus/projects/${encodeURIComponent(project.id)}/messages?page=${page}`,
          "GET",
          undefined,
          signal,
        );
        if (!signal.aborted) {
          setData(result);
          setError("");
          if (result.page !== page) pageCallback.current(result.page, true);
        }
      } catch (e) {
        if (!signal.aborted) setError(e.message);
      }
    }
    return startVisiblePolling(read, 10000);
  }, [request, project.id, page, reload]);
  const paging = data
    ? {
        total: data.total,
        page: data.page - 1,
        pageCount: Math.max(1, Math.ceil(data.total / data.pageSize)),
        pageSize: data.pageSize,
        start: data.total ? (data.page - 1) * data.pageSize + 1 : 0,
        end: Math.min(data.total, data.page * data.pageSize),
        setPage: (n) => onPage(n + 1),
      }
    : null;
  return {
    error,
    setReload,
    data,
    paging,
  };
}
