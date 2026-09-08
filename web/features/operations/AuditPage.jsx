import React, { useEffect, useState } from "react";
import useResource from "../../lib/useResource.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { operationsCopy as copy } from "../../lib/i18n/de/operations.js";
export default function AuditPage({ route, navigate }) {
  const query = new URLSearchParams({ page: String(route.auditPage || 1) });
  for (const [field, name] of [
    ["auditAction", "action"],
    ["auditOutcome", "outcome"],
    ["sessionIdFilter", "sessionId"],
    ["projectIdFilter", "projectId"],
    ["auditBefore", "before"],
  ])
    if (route[field]) query.set(name, route[field]);
  const resource = useResource("/audit?" + query),
    data = resource.data,
    page = route.auditPage || 1,
    pageCount = Math.max(1, Math.ceil((data?.total || 0) / (data?.pageSize || 25)));
  const [action, setAction] = useState(route.auditAction || ""),
    [session, setSession] = useState(route.sessionIdFilter || ""),
    [project, setProject] = useState(route.projectIdFilter || "");
  useEffect(() => {
    setAction(route.auditAction || "");
    setSession(route.sessionIdFilter || "");
    setProject(route.projectIdFilter || "");
  }, [route.auditAction, route.sessionIdFilter, route.projectIdFilter]);
  useEffect(() => {
    if (data && page > pageCount) navigate({ auditPage: pageCount }, true);
  }, [data, page, pageCount, navigate]);
  return (
    <section>
      <h1>{copy.audit}</h1>
      <p className="field-description">{copy.auditHelp}</p>
      <form
        className="operations-filters"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({
            auditAction: action,
            sessionIdFilter: session,
            projectIdFilter: project,
            auditPage: 1,
            auditBefore: "",
          });
        }}
      >
        <label>
          {copy.action}
          <input
            maxLength={100}
            value={action}
            onChange={(event) => setAction(event.target.value)}
          />
        </label>
        <label>
          {copy.outcome}
          <AnchoredSelect
            label={copy.outcome}
            value={route.auditOutcome || ""}
            onChange={(auditOutcome) =>
              navigate({ auditOutcome, auditPage: 1, auditBefore: "" })
            }
            options={[
              { value: "", label: copy.all },
              { value: "success", label: copy.success },
              { value: "failure", label: copy.failure },
            ]}
          />
        </label>
        <label>
          {copy.sessionId}
          <input
            maxLength={80}
            value={session}
            onChange={(event) => setSession(event.target.value)}
          />
        </label>
        <label>
          {copy.projectId}
          <input
            maxLength={80}
            value={project}
            onChange={(event) => setProject(event.target.value)}
          />
        </label>
        <button className="button secondary">{copy.filter}</button>
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            navigate({
              auditAction: "",
              auditOutcome: "",
              sessionIdFilter: "",
              projectIdFilter: "",
              auditPage: 1,
              auditBefore: "",
            })
          }
        >
          {copy.clear}
        </button>
      </form>
      <button
        className="button secondary"
        onClick={() =>
          route.auditBefore
            ? navigate({ auditBefore: "", auditPage: 1 })
            : resource.refresh()
        }
      >
        {copy.refresh}
      </button>
      <ErrorMessage error={resource.error} />
      {resource.loading && <p role="status">{copy.loading}</p>}
      {data?.events.map((event) => (
        <article className="operations-card" key={event.id}>
          <header>
            <strong>{event.action}</strong>
            <span>{event.outcome === "success" ? copy.success : copy.failure}</span>
          </header>
          <p>
            <time dateTime={event.createdAt}>{formatTimestamp(event.createdAt)}</time> ·{" "}
            {event.source === "mcp"
              ? copy.sourceMcp
              : event.source === "user"
                ? copy.sourceUser
                : copy.sourceSystem}
          </p>
          <p>
            {event.resourceType}
            {event.resourceId && ` · ${event.resourceId}`}
          </p>
          {event.sessionId && (
            <a href={`/sessions/${encodeURIComponent(event.sessionId)}/chat`}>
              {copy.sessionId}: {event.sessionId}
            </a>
          )}
          {event.details?.grantId && (
            <p>
              <a href="/settings/mcp">{copy.manageMcpAccess}</a>
            </p>
          )}
          {Object.keys(event.details || {}).length > 0 && (
            <details>
              <summary>{copy.details}</summary>
              <pre>{JSON.stringify(event.details, null, 2)}</pre>
            </details>
          )}
        </article>
      ))}
      {data && !data.events.length && <p>{copy.empty}</p>}
      {data && (
        <Pagination
          label={copy.audit}
          paging={{
            page: page - 1,
            pageCount,
            pageSize: data.pageSize,
            total: data.total,
            start: data.total ? (page - 1) * data.pageSize + 1 : 0,
            end: Math.min(data.total, page * data.pageSize),
            setPage: (index) =>
              navigate({ auditPage: index + 1, auditBefore: data.before }),
          }}
        />
      )}
    </section>
  );
}
