import React, { lazy, Suspense, useEffect, useState } from "react";
import Icon from "../../components/Icon.jsx";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import api from "../../lib/api.js";
import { appCopy } from "../../lib/i18n/messages/app.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  projectOverviewCopy as overviewCopy,
  projectsHubCopy as copy,
} from "../../lib/i18n/messages/projects.js";
import { repositoriesPageCopy } from "../../lib/i18n/messages/repositories.js";
import ProjectKnowledge from "./ProjectKnowledge.jsx";
import ProjectOverview from "./ProjectOverview.jsx";
import { projectSessions, remoteDisplay, remoteShort } from "./project-presentation.js";
import { resolveProjectId } from "./useProjectHub.js";
import { projectsRoute } from "./routes.js";
const AgentBus = lazy(() => import("../agentbus/AgentBusPage.jsx"));

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
  projects,
  credentials,
  route,
  onNavigate,
  sessions: allSessions,
  select,
  onLaunch,
  mobile,
  reloadHub,
}) {
  const runTotal = useRunTotal(project.memoryId);
  const sessions = projectSessions(allSessions, project);
  const credential = credentials.find((item) => item.id === project.credentialId);
  const branch = sessions.find((session) => session.branch)?.branch || "";
  const tab = route.projectTab || "overview";
  const Heading = mobile ? "h1" : "h2";
  const canonical = (id) => (id ? resolveProjectId(projects, id) || id : "");
  const meta = [
    project.remote ? remoteShort(project.remote) : copy.localOnly,
    branch,
    credential ? copy.tokenMeta(credential.name) : "",
  ].filter(Boolean);
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
  const pipelinesRoute = {
    view: "pipelines",
    pipelineTab: "runs",
    pipelineItem: "",
    pipelinePage: 1,
    pipelineStatus: "",
    projectId: project.memoryId,
  };
  return (
    <section className="project-card" aria-labelledby="project-card-title">
      <header className="project-card-header">
        <div>
          <Heading id="project-card-title">{project.name}</Heading>
          <span>{meta.join(" · ")}</span>
        </div>
        <div className="project-card-primary">
          <button
            type="button"
            className="button primary"
            aria-label={repositoriesPageCopy.buttonAriaLabel(project.name)}
            onClick={() => onLaunch(project.path)}
          >
            <Icon name="terminal" size={16} />
            {commonCopy.startSession}
          </button>
        </div>
      </header>
      <UnderlineTabs
        label={copy.tabsLabel}
        tabs={tabs}
        selected={tab}
        onSelect={(projectTab) =>
          projectTab !== tab &&
          onNavigate(projectsRoute({ projectId: project.id, projectTab }))
        }
      />
      <div
        className="project-tabpanel"
        role="tabpanel"
        id={`underline-tabpanel-${tab}`}
        aria-labelledby={`underline-tab-${tab}`}
      >
        {tab === "overview" && (
          <ProjectOverview facts={facts} sessions={sessions} select={select} />
        )}
        {tab === "knowledge" && (
          <ProjectKnowledge
            project={project}
            route={route}
            onNavigate={onNavigate}
            reloadHub={reloadHub}
          />
        )}
        {tab === "agentbus" && (
          // Interim: the pre-redesign AgentBus page, scoped to this project's bus.
          <div className="project-legacy">
            <Suspense fallback={<p className="loading">{appCopy.agentBusLoading}</p>}>
              <AgentBus
                request={api}
                tab={route.busTab || "status"}
                projectId={project.busId || project.id}
                page={route.messagePage || 1}
                onNavigate={(busTab, busId = "", replace = false, messagePage = 1) =>
                  onNavigate(
                    {
                      ...route,
                      projectTab: "agentbus",
                      busTab,
                      projectId: canonical(busId) || project.id,
                      messagePage,
                    },
                    replace,
                  )
                }
              />
            </Suspense>
          </div>
        )}
        {tab === "runs" && (
          <div className="project-runs">
            {project.memoryId ? (
              <>
                <p>{copy.runsDescription}</p>
                <a
                  className="button secondary"
                  href={`/pipelines?project=${encodeURIComponent(project.memoryId)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(pipelinesRoute);
                  }}
                >
                  {copy.runsLink}
                  <Icon name="arrow" size={16} />
                </a>
              </>
            ) : (
              <p className="project-empty">{copy.runsUnavailable}</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
