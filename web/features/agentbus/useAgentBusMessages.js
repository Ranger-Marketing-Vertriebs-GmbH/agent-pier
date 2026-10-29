import { useEffect, useRef } from "react";
import useLiveTopic, { useSafetyRead } from "../../lib/live/useLiveTopic.js";

// The server watches the project's queue folder; this read catches what a watch may
// miss (a handle lost between two events), visible tabs only.
export const AGENTBUS_SAFETY_MS = 60000;

/**
 * One page of a project's AgentBus messages, read once and again on each `changed`
 * of `agentbus.changed:<projectId>` (without the live channel every 10 s), plus a
 * safety read every 60 s while visible.
 */
export default function useAgentBusMessages({ project, page, onPage }) {
  const pageCallback = useRef(onPage);
  pageCallback.current = onPage;
  const { data, error, refresh } = useLiveTopic(
    `agentbus.changed:${project.id}`,
    `/agentbus/projects/${encodeURIComponent(project.id)}/messages?page=${page}`,
  );
  useSafetyRead(refresh, AGENTBUS_SAFETY_MS);
  useEffect(() => {
    if (data && data.page !== page) pageCallback.current(data.page, true);
  }, [data, page]);
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
  return { error, retry: refresh, data, paging };
}
