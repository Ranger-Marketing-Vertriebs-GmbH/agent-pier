import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import ListDetail from "../../components/ListDetail.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { projectsHubCopy as copy } from "../../lib/i18n/messages/projects.js";
import { repositoriesPageCopy } from "../../lib/i18n/messages/repositories.js";
import { getCloneOperation, subscribeToClone } from "../repositories/cloneStore.js";
import AddFolderDialog from "./AddFolderDialog.jsx";
import CloneDialog, { useCloneDraft } from "./CloneDialog.jsx";
import ProjectDetail from "./ProjectDetail.jsx";
import { remoteShort } from "./project-presentation.js";
import { projectsRoute, projectsRoutePath } from "./routes.js";
import useProjectHub, { resolveProjectId } from "./useProjectHub.js";
import useSettledReplace from "../../lib/useSettledReplace.js";
import useMobileLayout from "../../lib/useMobileLayout.js";
import "./projects.css";

export default function ProjectsPage({
  route,
  onNavigate,
  home,
  defaultCwd,
  state,
  select,
  onLaunch,
}) {
  const hub = useProjectHub();
  const { projects, reload } = hub;
  const operation = useSyncExternalStore(subscribeToClone, getCloneOperation);
  const draft = useCloneDraft({
    operation,
    defaultDirectory: defaultCwd || home || "",
    credentials: hub.credentials,
    loading: hub.loading,
  });
  const [dialog, setDialog] = useState(null);
  const mobile = useMobileLayout();
  const ready = !hub.loading;
  const canonical = resolveProjectId(projects, route.projectId);
  const project = projects.find((item) => item.id === canonical);
  const [retried, setRetried] = useState("");
  // Old links and other pages use repository, knowledge or AgentBus ids; the URL
  // settles on the joined project's id. Desktop opens the first project.
  const target = !ready
    ? null
    : route.projectId
      ? canonical && canonical !== route.projectId
        ? { ...route, projectId: canonical }
        : null
      : !mobile && projects.length
        ? { ...route, projectId: projects[0].id }
        : null;
  useSettledReplace({
    target,
    targetPath: target ? projectsRoutePath(target) : "",
    currentPath: projectsRoutePath(route),
    navigate: onNavigate,
  });
  useEffect(() => {
    if (
      !ready ||
      hub.error ||
      !route.projectId ||
      canonical ||
      retried === route.projectId
    )
      return;
    // A project added elsewhere (a new folder, a new session) is read once more.
    setRetried(route.projectId);
    reload();
  }, [ready, hub.error, route.projectId, canonical, retried, reload]);
  const clonedProjects = useRef(operation.projects);
  useEffect(() => {
    if (operation.projects === clonedProjects.current) return;
    clonedProjects.current = operation.projects;
    draft.setUrl("");
    draft.setFolderName("");
    if (dialog === "clone" && operation.projects[0]) {
      setDialog(null);
      onNavigate(projectsRoute({ projectId: operation.projects[0].id }));
    }
  }, [operation.projects, dialog, draft, onNavigate]);
  const choose = (projectId) =>
    onNavigate(projectsRoute({ projectId, projectTab: route.projectTab }));
  const missing =
    ready && route.projectId && !project && (retried === route.projectId || hub.error);
  return (
    <div className="page projects-hub">
      <div className="page-topline">
        <span>{copy.topline}</span>
        <span className="subtle">{copy.subtle}</span>
      </div>
      <header className="page-heading">
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
        <div className="projects-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => setDialog("folder")}
          >
            {copy.addFolder}
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => setDialog("clone")}
          >
            <Icon name="plus" size={16} />
            {commonCopy.cloneRepository}
          </button>
        </div>
      </header>
      {operation.notice && (
        <p className="repository-notice" role="status">
          {operation.notice}
        </p>
      )}
      {!dialog && <ErrorMessage error={operation.error} />}
      {hub.error && (
        <div className="repository-load-error project-load-error">
          <p>{copy.partialError}</p>
          <ErrorMessage error={hub.error} />
          <button className="button secondary" onClick={reload}>
            {commonCopy.retry}
          </button>
        </div>
      )}
      {hub.loading && !projects.length ? (
        <p role="status" className="loading">
          {copy.loading}
        </p>
      ) : !projects.length && !route.projectId ? (
        !hub.error && (
          <p className="project-empty">{repositoriesPageCopy.repositoryEmpty}</p>
        )
      ) : (
        <ListDetail
          className="project-list"
          listLabel={copy.listLabel}
          count={projects.length}
          items={projects}
          selectedId={route.projectId ? canonical || route.projectId : ""}
          onSelect={choose}
          mobileBackLabel={copy.back}
          renderItem={(item) => (
            <ProjectItem
              item={item}
              decisions={hub.attention.decisions[item.memoryId] || 0}
              failed={hub.attention.failed[item.memoryId] || 0}
            />
          )}
          detail={
            project ? (
              <ProjectDetail
                key={project.id}
                project={project}
                credentials={hub.credentials}
                route={route}
                onNavigate={onNavigate}
                sessions={state.sessions}
                select={select}
                onLaunch={onLaunch}
                mobile={mobile}
                reloadHub={reload}
                busProjects={hub.busProjects}
                busVersion={hub.busVersion}
                busNote={hub.busNote}
                busError={hub.errors.agentbus}
                home={home}
              />
            ) : missing ? (
              <section className="project-card project-missing">
                <h2>{copy.notFound}</h2>
                <p>{copy.notFoundDescription}</p>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => choose("")}
                >
                  {copy.back}
                </button>
              </section>
            ) : (
              <p role="status" className="loading">
                {copy.loading}
              </p>
            )
          }
        />
      )}
      {dialog === "clone" && (
        <CloneDialog
          draft={draft}
          operation={operation}
          credentials={hub.credentials}
          reload={0}
          close={() => setDialog(null)}
        />
      )}
      {dialog === "folder" && (
        <AddFolderDialog
          home={home}
          close={() => setDialog(null)}
          added={(added) => {
            setDialog(null);
            reload();
            onNavigate(projectsRoute({ projectId: added.id }));
          }}
        />
      )}
    </div>
  );
}

function ProjectItem({ item, decisions, failed }) {
  return (
    <>
      <span className="project-item-icon" aria-hidden="true">
        <Icon name="folder" size={16} />
      </span>
      <span className="project-item-text">
        <strong>{item.name}</strong>
        <small>{item.remote ? remoteShort(item.remote) : copy.localOnly}</small>
        {decisions > 0 && (
          <small className="project-hint decision">{copy.decisions(decisions)}</small>
        )}
        {failed > 0 && (
          <small className="project-hint failed">{copy.failedRuns(failed)}</small>
        )}
      </span>
      <Icon name="chevron" size={16} className="project-item-chevron" />
    </>
  );
}
