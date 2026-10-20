import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import useResource from "../../lib/useResource.js";
import useMobileLayout from "../../lib/useMobileLayout.js";
import useSettledReplace from "../../lib/useSettledReplace.js";
import ProjectRegistration from "./ProjectRegistration.jsx";
import VerificationList from "./VerificationList.jsx";
import QueueSettings from "./QueueSettings.jsx";
import QueueItems from "./QueueItems.jsx";
import useDraftGuard from "./useDraftGuard.jsx";
import useDraftParts from "./useDraftParts.js";
import { pipelineRoutePath } from "./routes.js";
import { listedProjects, listedProjectsPath } from "./project-list.js";
import { pipelineCopy } from "../../lib/i18n/messages/pipelines.js";
import { pipelineQueueCopy as copy } from "../../lib/i18n/messages/pipeline-queue.js";
import "./definitions.css";
import "./profiles.css";
import "./verification.css";
import "./queue.css";

// Started runs change on their own; the queue view follows them.
const QUEUE_POLL_MS = 3000;

/** Pipelines › Queue: a registered project's run queue and its concurrency limit. */
export default function QueuePage({ route, navigate, home }) {
  const projects = useResource(listedProjectsPath),
    projectId = route.pipelineItem || "",
    queue = useResource(
      projectId ? `/pipeline-queue/${encodeURIComponent(projectId)}` : null,
      { poll: QUEUE_POLL_MS },
    );
  const mobile = useMobileLayout();
  const draft = useDraftGuard(copy.discardDraft, route);
  const parts = useDraftParts(draft, ["settings"]);
  const all = projects.data?.projects || [],
    items = listedProjects(all, projectId),
    project = all.find((p) => p.id === projectId);
  // Desktop opens the first project; mobile shows the list first.
  const target =
    projects.data && !projectId && !mobile && items.length
      ? { ...route, pipelineItem: items[0].id }
      : null;
  useSettledReplace({
    target,
    targetPath: target ? pipelineRoutePath(target) : "",
    currentPath: pipelineRoutePath(route),
    navigate: (next, replace) => navigate({ pipelineItem: next.pipelineItem }, replace),
  });
  const open = (id) =>
    id !== projectId && draft.guarded(() => navigate({ pipelineItem: id }));
  const settings = queue.data?.settings;
  return (
    <section className="verification-page queue-page">
      <div className={`list-detail verification-layout${projectId ? " has-detail" : ""}`}>
        <div className="list-detail-list">
          <ProjectRegistration
            className="verification-register"
            resource={projects}
            home={home}
            onRegistered={(registered) => open(registered.id)}
          />
          {projects.loading && !projects.data && (
            <p role="status">{pipelineCopy.loading}</p>
          )}
          <nav aria-label={pipelineCopy.projects}>
            <p className="list-detail-caps" aria-hidden="true">
              {pipelineCopy.projects}
            </p>
            <VerificationList projects={items} selectedId={projectId} onSelect={open} />
          </nav>
        </div>
        <div className="list-detail-detail">
          {projectId && (
            <button
              type="button"
              className="list-detail-back"
              onClick={() => draft.guarded(() => navigate({ pipelineItem: "" }))}
            >
              <Icon name="back" size={16} />
              {pipelineCopy.allProjects}
            </button>
          )}
          <ErrorMessage error={queue.error} />
          {queue.loading && !queue.data && <p role="status">{copy.loading}</p>}
          {settings && (
            <QueueSettings
              key={projectId + JSON.stringify(settings)}
              projectId={projectId}
              initial={settings}
              saved={queue.refresh}
              {...parts.settings}
            />
          )}
          {queue.data && (
            <QueueItems
              project={{ id: projectId, name: project?.name || projectId }}
              items={queue.data.items}
              refresh={queue.refresh}
              onOpenRun={(id) =>
                draft.guarded(() =>
                  navigate({ pipelineTab: "runs", pipelineItem: id, projectId: "" }),
                )
              }
            />
          )}
        </div>
      </div>
      {draft.confirm}
    </section>
  );
}
