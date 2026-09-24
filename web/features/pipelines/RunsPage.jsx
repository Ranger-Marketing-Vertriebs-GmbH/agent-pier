import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import React, { useEffect, useState } from "react";
import Icon from "../../components/Icon.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import useResource from "../../lib/useResource.js";
import RunDetail from "./RunDetail.jsx";
import NewRunDialog from "./NewRunDialog.jsx";
import RunStatusFilter from "./RunStatusFilter.jsx";
import RunTable from "./RunTable.jsx";
import useRunStatusCounts from "./useRunStatusCounts.js";
import { runsPaging } from "./runs-paging.js";

export default function RunsPage({ route, navigate, home }) {
  const detail = route.pipelineItem && route.pipelineItem !== "new";
  const page = route.pipelinePage || 1,
    query = new URLSearchParams({
      page: String(page),
      ...(route.projectId ? { projectId: route.projectId } : {}),
      ...(route.pipelineStatus ? { status: route.pipelineStatus } : {}),
    });
  const [version, setVersion] = useState(0);
  const list = useResource(detail ? null : `/pipeline-runs?${query}`, { poll: 5000 }),
    projects = useResource("/memory/projects");
  const counts = useRunStatusCounts({
    projectId: route.projectId || "",
    enabled: !detail,
    version,
  });
  const paging = runsPaging({
    data: list.data,
    page,
    setPage: (pipelinePage) => navigate({ pipelinePage }),
  });
  useEffect(() => {
    if (list.data && page > paging.pageCount)
      navigate({ pipelinePage: paging.pageCount }, true);
  }, [list.data, page, paging.pageCount, navigate]);
  if (detail)
    return (
      <RunDetail key={route.pipelineItem} id={route.pipelineItem} navigate={navigate} />
    );
  return (
    <section>
      <div className="run-toolbar">
        <RunStatusFilter
          counts={counts}
          selected={route.pipelineStatus || ""}
          onSelect={(pipelineStatus) => navigate({ pipelineStatus, pipelinePage: 1 })}
        />
        <div className="run-toolbar-actions">
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
          <button
            className="button secondary"
            onClick={() => {
              list.refresh();
              setVersion((value) => value + 1);
            }}
          >
            {commonCopy.refresh}
          </button>
          <button
            className="button primary"
            onClick={() => navigate({ pipelineItem: "new", selectedPipeline: "" })}
          >
            <Icon name="plus" size={16} />
            {copy.newRun}
          </button>
        </div>
      </div>
      <ErrorMessage error={list.error || projects.error} />
      {list.loading && <p role="status">{copy.loading}</p>}
      {list.data && !paging.total && <p className="run-table-empty">{copy.noRuns}</p>}
      {list.data?.runs.length > 0 && (
        <RunTable
          runs={list.data.runs}
          onOpen={(run) => navigate({ pipelineItem: run.id })}
        />
      )}
      {list.data && <Pagination label={copy.runs} paging={paging} />}
      {route.pipelineItem === "new" && (
        <NewRunDialog
          route={route}
          home={home}
          close={() => navigate({ pipelineItem: "", selectedPipeline: "" })}
          onCreated={(run) => navigate({ pipelineItem: run.id, selectedPipeline: "" })}
        />
      )}
    </section>
  );
}
