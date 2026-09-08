import React, { useState } from "react";
import useResource from "../../lib/useResource.js";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { importedHistoryCopy as copy } from "../../lib/i18n/messages/operations.js";
export default function ImportedAgentBusHistory() {
  const projects = useResource("/operations/imported-history/agentbus"),
    [projectId, setProject] = useState(""),
    [page, setPage] = useState(1);
  const history = useResource(
      projectId
        ? `/operations/imported-history/agentbus/${encodeURIComponent(projectId)}?page=${page}`
        : null,
    ),
    data = history.data;
  if (!projects.error && !projects.data?.projects.length) return null;
  return (
    <section className="operations-card">
      <h2>{copy.title}</h2>
      <p className="field-description">{copy.readOnly}</p>
      <ErrorMessage error={projects.error || history.error} />
      <label>
        {copy.project}
        <AnchoredSelect
          label={copy.project}
          value={projectId}
          onChange={(value) => {
            setProject(value);
            setPage(1);
          }}
          options={[
            { value: "", label: copy.choose },
            ...(projects.data?.projects || []).map((project) => ({
              value: project.id,
              label: project.id.length > 24 ? project.id.slice(0, 24) + "…" : project.id,
            })),
          ]}
        />
      </label>
      {history.loading && <p role="status">{copy.loading}</p>}
      {data?.truncated && <p>{copy.truncated}</p>}
      {data?.items.map((item) => (
        <article className="operations-card" key={item.id}>
          <header>
            <strong>
              {item.from?.name || item.from?.tool || copy.unknown} →{" "}
              {item.to?.name || item.to?.tool || copy.unknown}
            </strong>
          </header>
          <p>
            <time dateTime={item.createdAt}>{formatTimestamp(item.createdAt)}</time> ·{" "}
            <span>{item.status === "read" ? copy.read : copy.pending}</span>
          </p>
          <pre>{item.text}</pre>
        </article>
      ))}
      {data && !data.items.length && <p>{copy.empty}</p>}
      {data && (
        <Pagination
          label={copy.title}
          paging={{
            page: page - 1,
            pageCount: Math.max(1, Math.ceil(data.total / data.pageSize)),
            pageSize: data.pageSize,
            total: data.total,
            start: data.total ? (page - 1) * data.pageSize + 1 : 0,
            end: Math.min(data.total, page * data.pageSize),
            setPage: (index) => setPage(index + 1),
          }}
        />
      )}
    </section>
  );
}
