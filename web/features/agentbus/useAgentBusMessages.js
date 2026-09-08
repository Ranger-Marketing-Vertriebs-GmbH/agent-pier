import { useEffect, useState, useRef } from "react";
export default function useAgentBusMessages({ request, project, page, onPage }) {
  const pageCallback = useRef(onPage);
  pageCallback.current = onPage;
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true,
      timer;
    setData(null);
    setError("");
    async function read() {
      try {
        const result = await request(
          `/agentbus/projects/${encodeURIComponent(project.id)}/messages?page=${page}`,
        );
        if (active) {
          setData(result);
          setError("");
          if (result.page !== page) pageCallback.current(result.page, true);
        }
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) timer = setTimeout(read, 4000);
      }
    }
    read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
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
