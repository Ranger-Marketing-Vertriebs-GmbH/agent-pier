import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import ListDetail from "../../components/ListDetail.jsx";
import { unknownValue } from "../../components/ListRow.jsx";
import SettingsShell from "../../components/SettingsShell.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { projectsHubCopy as copy } from "../../lib/i18n/messages/projects.js";
import { repositoriesPageCopy } from "../../lib/i18n/messages/repositories.js";
import { getCloneOperation, subscribeToClone } from "../repositories/cloneStore.js";
import AddFolderDialog from "./AddFolderDialog.jsx";
import CloneDialog, { useCloneDraft } from "./CloneDialog.jsx";
import MergeDuplicateDialog from "./MergeDuplicateDialog.jsx";
import ProjectAddMenu from "./ProjectAddMenu.jsx";
import ProjectDetail from "./ProjectDetail.jsx";
import ProjectList from "./ProjectList.jsx";
import { projectAttention } from "./project-presentation.js";
import { normalizePath } from "./project-paths.js";
import { projectsRoute, projectsRoutePath } from "./routes.js";
import useProjectHub, { resolveProjectId } from "./useProjectHub.js";
import useSettledReplace from "../../lib/useSettledReplace.js";
import useMobileLayout from "../../lib/useMobileLayout.js";
import "./projects.css";
import "./project-tabs.css";

export default function ProjectsPage({
  route,
  onNavigate,
  home,
  defaultCwd,
  state,
  select,
  onLaunch,
  openNavigation,
  navigationOpen = false,
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
  // The id of the project whose older entry the merge dialog merges.
  const [mergingId, setMergingId] = useState("");
  // A dialog unmounts its native <dialog> without restoring focus; return it to the
  // opener (a menu item that closed itself names its ⋯ trigger instead).
  const opener = useRef(null);
  const openDialog = (name, from = document.activeElement) => {
    opener.current = from;
    setDialog(name);
  };
  // Older entries of a folder merge one at a time, the most recent first.
  const merge = (item, from) => {
    setMergingId(item.id);
    openDialog("merge", from);
  };
  useEffect(() => {
    if (dialog) return;
    const element = opener.current;
    opener.current = null;
    if (element?.isConnected) element.focus();
  }, [dialog]);
  const mobile = useMobileLayout();
  // Folders with a running session, the way the overview marks a session "Running".
  const runningPaths = useMemo(
    () =>
      new Set(
        (state.sessions || [])
          .filter(
            (session) => session.purpose !== "login" && session.status === "running",
          )
          .map((session) => normalizePath(session.cwd)),
      ),
    [state.sessions],
  );
  const merging = projects.find((item) => item.id === mergingId);
  const mergeOlder = merging?.olderDuplicates?.[0];
  // A live reload may drop the older entry while its dialog is open: the dialog closes
  // and focus returns to its opener.
  useEffect(() => {
    if (dialog === "merge" && !mergeOlder) setDialog(null);
  }, [dialog, mergeOlder]);
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
  const notices = (
    <>
      {operation.notice && (
        <p className="repository-notice" role="status">
          {operation.notice}
        </p>
      )}
      {!dialog && <ErrorMessage error={operation.error} />}
      <ErrorMessage error={hub.groups.error} />
      {hub.error && (
        <div className="repository-load-error project-load-error">
          <p>{copy.partialError}</p>
          <ErrorMessage error={hub.error} />
          <button className="button secondary" onClick={hub.retry}>
            {commonCopy.retry}
          </button>
        </div>
      )}
    </>
  );
  const loadingStatus = (
    <p role="status" className="loading">
      {copy.loading}
    </p>
  );
  const missingCard = (
    <section className="project-card project-missing">
      <h2>{copy.notFound}</h2>
      <p>{copy.notFoundDescription}</p>
      <button type="button" className="button secondary" onClick={() => choose("")}>
        {copy.back}
      </button>
    </section>
  );
  const detail = (item) => (
    <ProjectDetail
      key={item.id}
      project={item}
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
      attention={projectAttention(hub.attention, item.memoryId)}
      groups={hub.groups}
      running={runningPaths.has(normalizePath(item.path))}
      onMerge={(from) => merge(item, from)}
      notices={mobile ? notices : null}
      onBack={() => choose("")}
    />
  );
  const dialogs = (
    <>
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
      {dialog === "merge" && mergeOlder && (
        <MergeDuplicateDialog
          project={merging}
          older={mergeOlder}
          close={() => setDialog(null)}
          merged={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
    </>
  );
  // Phones show a selected project as its own page with a back arrow.
  if (mobile && route.projectId)
    return (
      <>
        {project ? (
          detail(project)
        ) : (
          <SettingsShell
            className="projects-hub project-detail-shell"
            leading="back"
            onLeading={() => choose("")}
            leadingLabel={copy.back}
            title={copy.title}
          >
            {notices}
            {missing ? missingCard : loadingStatus}
          </SettingsShell>
        )}
        {dialogs}
      </>
    );
  const selectedId = route.projectId ? canonical || route.projectId : "";
  const count =
    (hub.loading || hub.error) && !projects.length
      ? unknownValue
      : copy.projectsCount(projects.length);
  const actions = mobile ? (
    <ProjectAddMenu
      label={copy.addMenu}
      items={[
        {
          id: "clone",
          label: commonCopy.cloneRepository,
          onSelect: () => openDialog("clone"),
        },
        { id: "folder", label: copy.addFolder, onSelect: () => openDialog("folder") },
      ]}
    />
  ) : (
    <>
      <button
        type="button"
        className="button secondary"
        onClick={() => openDialog("folder")}
      >
        {copy.addFolder}
      </button>
      <button
        type="button"
        className="button primary"
        onClick={() => openDialog("clone")}
      >
        <Icon name="plus" size={16} />
        {commonCopy.cloneRepository}
      </button>
    </>
  );
  return (
    <SettingsShell
      className="projects-hub"
      leading="menu"
      onLeading={openNavigation}
      navigationOpen={navigationOpen}
      title={copy.title}
      subtitle={`${count} · ${copy.subtle}`}
      description={copy.description}
      actions={actions}
    >
      {notices}
      {hub.loading && !projects.length ? (
        loadingStatus
      ) : !projects.length && !route.projectId ? (
        !hub.error && (
          <p className="project-empty">{repositoriesPageCopy.repositoryEmpty}</p>
        )
      ) : (
        <ListDetail
          className="project-list"
          listLabel={copy.listLabel}
          selectedId={selectedId}
          list={
            <ProjectList
              projects={projects}
              groups={hub.groups}
              selectedId={selectedId}
              onSelect={choose}
              attentionFor={(item) => projectAttention(hub.attention, item.memoryId)}
              isRunning={(item) => runningPaths.has(normalizePath(item.path))}
              onMerge={merge}
            />
          }
          detail={project ? detail(project) : missing ? missingCard : loadingStatus}
        />
      )}
      {dialogs}
    </SettingsShell>
  );
}
