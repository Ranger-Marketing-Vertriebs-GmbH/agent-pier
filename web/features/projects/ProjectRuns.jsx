import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import useResource from "../../lib/useResource.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { pipelineCopy } from "../../lib/i18n/messages/pipelines.js";
import { projectsHubCopy as copy } from "../../lib/i18n/messages/projects.js";
import NewRunDialog from "../pipelines/NewRunDialog.jsx";
import RunStatusFilter from "../pipelines/RunStatusFilter.jsx";
import RunTable from "../pipelines/RunTable.jsx";
import { runsPaging } from "../pipelines/runs-paging.js";
import useRunStatusCounts from "../pipelines/useRunStatusCounts.js";
import { projectsRoute, projectsRoutePath } from "./routes.js";
import useSettledReplace from "./useSettledReplace.js";

const runRoute = (pipelineItem) => ({
  view: "pipelines",
  pipelineTab: "runs",
  pipelineItem,
  pipelinePage: 1,
  pipelineStatus: "",
  projectId: "",
});

function RegisterHint({ project, onNavigate, reloadHub }) {
  const action = useAsyncAction();
  return (
    <div className="project-runs">
      <p className="project-empty">{copy.runsUnavailable}</p>
      <ErrorMessage error={action.error} />
      <button
        type="button"
        className="button primary"
        disabled={action.busy}
        onClick={() =>
          action.run(async () => {
            const selected = await api("/memory/projects", "POST", { cwd: project.path });
            reloadHub();
            onNavigate(projectsRoute({ projectId: selected.id, projectTab: "runs" }));
          })
        }
      >
        {pipelineCopy.registerProject}
      </button>
    </div>
  );
}

export default function ProjectRuns({ project, route, onNavigate, home, reloadHub }) {
  const memoryId = project.memoryId;
  const status = route.pipelineStatus || "",
    page = route.pipelinePage || 1;
  const [version, setVersion] = useState(0);
  const [starting, setStarting] = useState(false);
  const query = new URLSearchParams({
    page: String(page),
    projectId: memoryId || "",
    ...(status ? { status } : {}),
  });
  const list = useResource(memoryId ? `/pipeline-runs?${query}` : null, { poll: 5000 });
  const counts = useRunStatusCounts({
    projectId: memoryId || "",
    enabled: Boolean(memoryId),
    version,
  });
  const navigate = (changes) =>
    onNavigate({ ...route, projectId: project.id, projectTab: "runs", ...changes });
  const paging = runsPaging({
    data: list.data,
    page,
    setPage: (pipelinePage) => navigate({ pipelinePage }),
  });
  const pageTarget =
    list.data && page > paging.pageCount
      ? {
          ...route,
          projectId: project.id,
          projectTab: "runs",
          pipelinePage: paging.pageCount,
        }
      : null;
  useSettledReplace({
    target: pageTarget,
    targetPath: pageTarget ? projectsRoutePath(pageTarget) : "",
    currentPath: projectsRoutePath(route),
    navigate: onNavigate,
  });
  if (!memoryId)
    return (
      <RegisterHint project={project} onNavigate={onNavigate} reloadHub={reloadHub} />
    );
  return (
    <div className="project-runs-table">
      <div className="run-toolbar">
        <RunStatusFilter
          counts={counts}
          selected={status}
          onSelect={(pipelineStatus) => navigate({ pipelineStatus, pipelinePage: 1 })}
        />
        <div className="run-toolbar-actions">
          <button
            type="button"
            className="button secondary compact"
            onClick={() => {
              list.refresh();
              setVersion((value) => value + 1);
            }}
          >
            {commonCopy.refresh}
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => setStarting(true)}
          >
            <Icon name="plus" size={16} />
            {pipelineCopy.newRun}
          </button>
        </div>
      </div>
      <ErrorMessage error={list.error} />
      {list.loading && <p role="status">{pipelineCopy.loading}</p>}
      {list.data && !paging.total && (
        <p className="run-table-empty">{pipelineCopy.noRuns}</p>
      )}
      {list.data?.runs.length > 0 && (
        <RunTable
          runs={list.data.runs}
          showProject={false}
          onOpen={(run) => onNavigate(runRoute(run.id))}
        />
      )}
      {list.data && <Pagination label={pipelineCopy.runs} paging={paging} />}
      {starting && (
        <NewRunDialog
          home={home}
          fixedProject={{ id: memoryId, cwd: project.path }}
          close={() => setStarting(false)}
          onCreated={(run) => onNavigate(runRoute(run.id))}
        />
      )}
    </div>
  );
}
