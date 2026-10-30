import React, { useState } from "react";
import Icon from "../../components/Icon.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import SettingsShell from "../../components/SettingsShell.jsx";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import api from "../../lib/api.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  projectDialogsCopy as dialogsCopy,
  projectOverviewCopy as overviewCopy,
  projectsHubCopy as copy,
  projectApprovalsCopy,
} from "../../lib/i18n/messages/projects.js";
import { repositoriesPageCopy } from "../../lib/i18n/messages/repositories.js";
import ProjectAgentBus from "./ProjectAgentBus.jsx";
import ProjectAgents from "./ProjectAgents.jsx";
import ProjectApprovals from "./ProjectApprovals.jsx";
import { projectAgentsCopy } from "../../lib/i18n/messages/project-agents.js";
import { projectGroupsCopy } from "../../lib/i18n/messages/project-groups.js";
import ProjectGroupNameRow from "./ProjectGroupNameRow.jsx";
import ProjectKnowledge from "./ProjectKnowledge.jsx";
import ProjectMenuButton from "./ProjectMenuButton.jsx";
import ProjectOverview from "./ProjectOverview.jsx";
import ProjectRuns from "./ProjectRuns.jsx";
import { groupNameMessage, projectMenuItems, projectMenuSheet } from "./project-menu.js";
import { projectSessions, remoteDisplay, remoteShort } from "./project-presentation.js";
import { projectsRoute } from "./routes.js";

// The project's run total, pushed with its run counts (`pipeline.counts:<project>`).
function useRunTotal(memoryId) {
  const { data } = useLiveTopic(memoryId ? `pipeline.counts:${memoryId}` : null);
  if (!memoryId) return 0;
  return Number.isFinite(data?.total) ? data.total : undefined;
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
  groups,
  running,
  onMerge,
  notices,
  onBack,
}) {
  const runTotal = useRunTotal(project.memoryId);
  const group = groups.groupOf(project.path);
  // Phones: the ⋯ sheet's "New group …" opens the name field above the tab content;
  // `creating` holds the ⋯ trigger that gets focus back.
  const [creating, setCreating] = useState(null);
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
    // Phones show these two side by side.
    {
      label: overviewCopy.branch,
      value: branch || "—",
      mono: Boolean(branch),
      half: true,
    },
    {
      label: overviewCopy.tokenProfile,
      value: credential?.name || overviewCopy.noToken,
      half: true,
    },
    { label: overviewCopy.folder, value: project.path, mono: true },
    {
      label: projectGroupsCopy.factGroup,
      value: group?.name || projectGroupsCopy.ungrouped,
      muted: !group,
    },
  ];
  const tabs = [
    { id: "overview", label: copy.tabOverview },
    { id: "knowledge", label: copy.tabKnowledge, count: project.entryCount },
    { id: "agentbus", label: copy.tabAgentBus, count: project.sessionCount },
    { id: "runs", label: copy.tabRuns, count: runTotal },
    { id: "agents", label: projectAgentsCopy.tab },
    { id: "approvals", label: projectApprovalsCopy.tab },
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
      {older && !mobile && (
        <button
          type="button"
          className="button secondary"
          onClick={(event) => onMerge(event.currentTarget)}
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
      {tab === "agents" && (
        <ProjectAgents project={project} onNavigate={onNavigate} reloadHub={reloadHub} />
      )}
      {tab === "approvals" && (
        <ProjectApprovals
          project={project}
          onNavigate={onNavigate}
          reloadHub={reloadHub}
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
  if (mobile) {
    const closeCreate = () => {
      const trigger = creating;
      setCreating(null);
      queueMicrotask(() => trigger?.isConnected && trigger.focus());
    };
    const menu = (
      <ProjectMenuButton
        className="project-detail-more"
        label={projectGroupsCopy.projectActions(project.name)}
        sheet={projectMenuSheet(project, group)}
        items={projectMenuItems({
          groups: groups.document.groups,
          current: group,
          onMove: (groupId) => groups.moveProject(project.path, groupId),
          onNewGroup: (trigger) => setCreating(trigger),
          onRemove: () => groups.removeProject(project.path),
          onMerge: older ? onMerge : undefined,
        })}
      />
    );
    const chips = (group || running) && (
      <span className="project-chips">
        {group && (
          <span className="project-group-chip">
            <Icon name="folder" size={14} />
            {group.name}
          </span>
        )}
        {running && (
          <StatusChip tone="ok" pill>
            {projectGroupsCopy.sessionRunning}
          </StatusChip>
        )}
      </span>
    );
    return (
      <SettingsShell
        className="projects-hub project-detail-shell"
        leading="back"
        onLeading={onBack}
        leadingLabel={copy.back}
        title={project.name}
        subtitle={
          <>
            <span className="project-detail-meta">{meta}</span>
            {chips}
          </>
        }
        actions={menu}
        tabs={tabRow}
        bar={<div className="project-launch-bar">{actions}</div>}
      >
        {notices}
        {creating && (
          <ProjectGroupNameRow
            submitLabel={projectGroupsCopy.createGroup}
            validate={(name) => groupNameMessage(groups.document, name)}
            onSubmit={async (name) => {
              await groups.createGroup(name, project.path);
              closeCreate();
            }}
            onCancel={closeCreate}
          />
        )}
        {panel}
      </SettingsShell>
    );
  }
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
    </section>
  );
}
