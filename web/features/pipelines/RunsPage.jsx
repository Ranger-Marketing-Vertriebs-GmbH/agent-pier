import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import React, { useEffect } from "react";
import { Pagination } from "../../components/Pagination.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/de/pipelines.js";
import { commonCopy } from "../../lib/i18n/de/common.js";
import useResource from "../../lib/useResource.js";
import RunDetail from "./RunDetail.jsx";
import NewRun from "./NewRun.jsx";
export default function RunsPage({ route, navigate, home }) {
  const page = route.pipelinePage || 1,
    query = new URLSearchParams({
      page: String(page),
      ...(route.projectId ? { projectId: route.projectId } : {}),
      ...(route.pipelineStatus ? { status: route.pipelineStatus } : {}),
    });
  const list = useResource(route.pipelineItem ? null : `/pipeline-runs?${query}`, {
      poll: 5000,
    }),
    projects = useResource("/memory/projects");
  const total = list.data?.total || 0,
    pageSize = list.data?.pageSize || 20,
    pageCount = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => {
    if (list.data && page > pageCount) navigate({ pipelinePage: pageCount }, true);
  }, [list.data, page, pageCount, navigate]);
  if (route.pipelineItem === "new")
    return (
      <NewRun
        home={home}
        selectedPipeline={route.selectedPipeline}
        started={(run) => navigate({ pipelineItem: run.id })}
        cancel={() => navigate({ pipelineItem: "" })}
      />
    );
  if (route.pipelineItem)
    return <RunDetail id={route.pipelineItem} navigate={navigate} />;
  return (
    <section>
      <div className="pipeline-toolbar">
        <h2>{copy.runs}</h2>
        <button
          className="button primary"
          onClick={() => navigate({ pipelineItem: "new" })}
        >
          {copy.newRun}
        </button>
        <button className="button secondary" onClick={list.refresh}>
          {commonCopy.refresh}
        </button>
      </div>
      <div className="pipeline-controls">
        <label>
          {copy.project}
          <AnchoredSelect
            label={copy.project}
            value={route.projectId || ""}
            onChange={(value) => navigate({ projectId: value, pipelinePage: 1 })}
            options={[
              { value: "", label: copy.allProjects },
              ...(projects.data?.projects || []).map((project) => ({
                value: project.id,
                label: project.name,
              })),
            ]}
          />
        </label>
        <label>
          {copy.status}
          <AnchoredSelect
            label={copy.status}
            value={route.pipelineStatus || ""}
            onChange={(value) => navigate({ pipelineStatus: value, pipelinePage: 1 })}
            options={[
              { value: "", label: copy.allStatuses },
              ...Object.entries(copy.statuses).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
        </label>
      </div>
      <ErrorMessage error={list.error || projects.error} />
      {list.loading && <p role="status">{copy.loading}</p>}
      {list.data && !total && <p>{copy.noRuns}</p>}
      {Object.entries(copy.statuses).map(([status, label]) => {
        const runs = list.data?.runs.filter((run) => run.status === status) || [];
        return runs.length ? (
          <section key={status}>
            <h3>{label}</h3>
            {runs.map((run) => (
              <article className="pipeline-card" key={run.id}>
                <h3>{run.task}</h3>
                <p>
                  {run.pipelineName} · {run.cwd}
                </p>
                <div className="pipeline-actions">
                  <button
                    className="button secondary"
                    aria-label={`${copy.openRun}: ${run.task}`}
                    onClick={() => navigate({ pipelineItem: run.id })}
                  >
                    {copy.openRun}
                  </button>
                  <small>
                    {run.nodes
                      ?.map(
                        (node) =>
                          `${node.profileSnapshot?.name || node.id}: ${copy.nodeStatuses[node.status] || node.status}`,
                      )
                      .join(" · ")}
                  </small>
                </div>
              </article>
            ))}
          </section>
        ) : null;
      })}
      {list.data && (
        <Pagination
          label={copy.runs}
          paging={{
            page: page - 1,
            pageCount,
            pageSize,
            total,
            start: total ? (page - 1) * pageSize + 1 : 0,
            end: Math.min(total, page * pageSize),
            setPage: (index) => navigate({ pipelinePage: index + 1 }),
          }}
        />
      )}
    </section>
  );
}
