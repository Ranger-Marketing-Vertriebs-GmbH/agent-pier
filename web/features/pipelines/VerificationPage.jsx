import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import useResource from "../../lib/useResource.js";
import useMobileLayout from "../../lib/useMobileLayout.js";
import useSettledReplace from "../../lib/useSettledReplace.js";
import ProjectRegistration from "./ProjectRegistration.jsx";
import VerificationEditor from "./VerificationEditor.jsx";
import VerificationList from "./VerificationList.jsx";
import useDraftGuard from "./useDraftGuard.jsx";
import { pipelineRoutePath } from "./routes.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import "./profiles.css";
import "./verification.css";

export default function VerificationPage({ route, navigate, home }) {
  const projects = useResource("/memory/projects"),
    projectId = route.pipelineItem || "",
    config = useResource(
      projectId ? `/pipeline-verification/${encodeURIComponent(projectId)}` : null,
    );
  const mobile = useMobileLayout();
  const draft = useDraftGuard(copy.discardVerificationDraft);
  const items = projects.data?.projects || [],
    project = items.find((p) => p.id === projectId);
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
  return (
    <section className="verification-page">
      <div className={`list-detail verification-layout${projectId ? " has-detail" : ""}`}>
        <div className="list-detail-list">
          <ProjectRegistration
            className="verification-register"
            resource={projects}
            home={home}
            onRegistered={(registered) => open(registered.id)}
          />
          {projects.loading && !projects.data && <p role="status">{copy.loading}</p>}
          <nav aria-label={copy.projects}>
            <p className="list-detail-caps" aria-hidden="true">
              {copy.projects}
            </p>
            <VerificationList
              projects={items}
              selectedId={projectId}
              stepCount={config.data?.steps?.length}
              onSelect={open}
            />
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
              {copy.allProjects}
            </button>
          )}
          <ErrorMessage error={config.error} />
          {config.loading && <p role="status">{copy.loading}</p>}
          {config.data && (
            <VerificationEditor
              key={projectId + JSON.stringify(config.data)}
              projectId={projectId}
              name={project?.name || projectId}
              initial={config.data.steps}
              saved={config.refresh}
              onDirtyChange={draft.setDirty}
            />
          )}
        </div>
      </div>
      {draft.confirm}
    </section>
  );
}
