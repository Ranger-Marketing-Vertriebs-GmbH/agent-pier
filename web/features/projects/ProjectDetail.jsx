import React, { useEffect, useState } from "react";
import Icon from "../../components/Icon.jsx";
import SettingsShell from "../../components/SettingsShell.jsx";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  projectDialogsCopy as dialogsCopy,
  projectOverviewCopy as overviewCopy,
  projectsHubCopy as copy,
} from "../../lib/i18n/messages/projects.js";
import { repositoriesPageCopy } from "../../lib/i18n/messages/repositories.js";
import MergeDuplicateDialog from "./MergeDuplicateDialog.jsx";
import ProjectAgentBus from "./ProjectAgentBus.jsx";
import ProjectKnowledge from "./ProjectKnowledge.jsx";
import ProjectOverview from "./ProjectOverview.jsx";
import ProjectRuns from "./ProjectRuns.jsx";
import { projectSessions, remoteDisplay, remoteShort } from "./project-presentation.js";
import { projectsRoute } from "./routes.js";

function useRunTotal(memoryId) {
  const [total, setTotal] = useState(undefined);
  useEffect(() => {
    if (!memoryId) {
      setTotal(0);
      return;
    }
    let alive = true;
    setTotal(undefined);
    api(`/pipeline-runs?projectId=${encodeURIComponent(memoryId)}`)
      .then((data) => {
        if (alive) setTotal(data.total || 0);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [memoryId]);
  return total;
}

export default function ProjectDetail({
  project,
  credentials,
  route,
  onNavigate,
  sessions: allSessions,
  select,
  onLaunch,
  mobile,
  reloadHub,
  busProjects,
  busVersion,
  busNote,
  busError,
  home,
  attention,
  notices,
  onBack,
}) {
  const runTotal = useRunTotal(project.memoryId);
  const [merging, setMerging] = useState(false);
  // Older entries of this folder merge one at a time, the most recent first.
  const older = project.olderDuplicates?.[0];
  const sessions = projectSessions(allSessions, project);
  const credential = credentials.find((item) => item.id === project.credentialId);
  const branch = sessions.find((session) => session.branch)?.branch || "";
  const tab = route.projectTab || "overview";
  const meta = [
    project.remote ? remoteShort(project.remote) : copy.localOnly,
    branch,
    credential ? copy.tokenMeta(credential.name) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const facts = [
    {
      label: overviewCopy.remote,
      value: remoteDisplay(project.remote) || copy.localOnly,
    },
    { label: overviewCopy.branch, value: branch || "—", mono: Boolean(branch) },
    { label: overviewCopy.tokenProfile, value: credential?.name || overviewCopy.noToken },
    { label: overviewCopy.folder, value: project.path, mono: true },
  ];
  const tabs = [
    { id: "overview", label: copy.tabOverview },
    { id: "knowledge", label: copy.tabKnowledge, count: project.entryCount },
    { id: "agentbus", label: copy.tabAgentBus, count: project.sessionCount },
    { id: "runs", label: copy.tabRuns, count: runTotal },
  ];
  const tabRow = (
    <UnderlineTabs
      label={copy.tabsLabel}
      tabs={tabs}
      selected={tab}
      onSelect={(projectTab) =>
        projectTab !== tab &&
        onNavigate(projectsRoute({ projectId: project.id, projectTab }))
      }
    />
  );
  const actions = (
    <>
      {older && (
        <button
          type="button"
          className="button secondary"
          onClick={() => setMerging(true)}
        >
          {dialogsCopy.mergeOlder}
        </button>
      )}
      <button
        type="button"
        className="button primary"
        aria-label={repositoriesPageCopy.buttonAriaLabel(project.name)}
        onClick={() => onLaunch(project.path)}
      >
        <Icon name="terminal" size={16} />
        {commonCopy.startSession}
      </button>
    </>
  );
  const panel = (
    <div
      className="project-tabpanel"
      role="tabpanel"
      id={`underline-tabpanel-${tab}`}
      aria-labelledby={`underline-tab-${tab}`}
    >
      {tab === "overview" && (
        <ProjectOverview
          projectId={project.id}
          facts={facts}
          sessions={sessions}
          select={select}
          attention={attention}
          onNavigate={onNavigate}
          mobile={mobile}
        />
      )}
      {tab === "knowledge" && (
        <ProjectKnowledge
          project={project}
          route={route}
          onNavigate={onNavigate}
          reloadHub={reloadHub}
          mobile={mobile}
        />
      )}
      {tab === "agentbus" && (
        <ProjectAgentBus
          request={api}
          project={project}
          busProjects={busProjects}
          busVersion={busVersion}
          busNote={busNote}
          busError={busError}
          reloadBus={reloadHub}
          route={route}
          mobile={mobile}
          onNavigate={(busTab, messagePage = 1, replace = false) =>
            onNavigate({ ...route, projectTab: "agentbus", busTab, messagePage }, replace)
          }
        />
      )}
      {tab === "runs" && (
        <ProjectRuns
          project={project}
          route={route}
          onNavigate={onNavigate}
          home={home}
          reloadHub={reloadHub}
        />
      )}
    </div>
  );
  const mergeDialog = merging && older && (
    <MergeDuplicateDialog
      project={project}
      older={older}
      close={() => setMerging(false)}
      merged={() => {
        setMerging(false);
        reloadHub();
      }}
    />
  );
  if (mobile)
    return (
      <SettingsShell
        className="projects-hub project-detail-shell"
        leading="back"
        onLeading={onBack}
        leadingLabel={copy.back}
        title={project.name}
        subtitle={meta}
        tabs={tabRow}
        bar={<div className="project-launch-bar">{actions}</div>}
      >
        {notices}
        {panel}
        {mergeDialog}
      </SettingsShell>
    );
  return (
    <section className="project-card" aria-labelledby="project-card-title">
      <header className="project-card-header">
        <div>
          <h2 id="project-card-title">{project.name}</h2>
          <span>{meta}</span>
        </div>
        <div className="project-card-primary">{actions}</div>
      </header>
      {tabRow}
      {panel}
      {mergeDialog}
    </section>
  );
}
