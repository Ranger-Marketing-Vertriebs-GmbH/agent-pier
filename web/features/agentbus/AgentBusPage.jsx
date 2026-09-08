import ErrorMessage from "../../components/ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/de/common.js";
import { agentBusPageCopy as copy } from "../../lib/i18n/de/agentbus.js";
import React from "react";
import MessageLog from "./MessageLog.jsx";
import useAgentBusStatus from "./useAgentBusStatus.js";
export default function AgentBus({
  request,
  tab = "status",
  projectId = "",
  page = 1,
  onNavigate = () => {},
}) {
  const { error, setReload, data, sessions, projects, project } = useAgentBusStatus({
    request,
    tab,
    projectId,
    page,
    onNavigate,
  });
  return (
    <div className="page extensions-page agentbus-page">
      <div className="page-topline">
        <span>{copy.pageToplineLabel}</span>
        <span className="subtle">{copy.subtle}</span>
      </div>
      <header className="page-heading">
        <div>
          <h1>{copy.pageHeadingTitle}</h1>
          <p>{copy.pageHeadingDescription}</p>
        </div>
      </header>
      <div
        className="agentbus-tabs"
        role="tablist"
        aria-label={copy.agentbusTabsAriaLabel}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "status"}
          onClick={() => {
            if (tab !== "status") onNavigate("status");
          }}
        >
          {copy.statusTab}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "messages"}
          onClick={() => {
            if (tab !== "messages") onNavigate("messages", projectId);
          }}
        >
          {copy.messagesTab}
        </button>
      </div>
      {error && (
        <div className="extension-load-error">
          <ErrorMessage error={error} as="p" />
          <button className="button secondary" onClick={() => setReload((n) => n + 1)}>
            {commonCopy.reload}
          </button>
        </div>
      )}
      {!data && !error ? (
        <p className="loading" role="status">
          {copy.statusLoading}
        </p>
      ) : (
        data && (
          <>
            {tab === "status" ? (
              <>
                <div className="extension-scope-note">
                  <strong>{copy.extensionScopeNoteLabel}</strong>
                  <p>{copy.extensionScopeNoteDescription}</p>
                </div>
                <div className="agentbus-summary">
                  <span>
                    {sessions.filter((s) => s.registered).length}
                    {copy.connectedSessionsSuffix}
                  </span>
                  <span>
                    {sessions.reduce((n, s) => n + (s.pending || 0), 0)}{" "}
                    {copy.pendingMessagesSuffix}
                  </span>
                  <span>
                    {copy.versionPrefix}
                    {data.version}
                  </span>
                </div>
                <p className="field-description">{data.note}</p>
                {projects.length ? (
                  projects.map((project) => (
                    <section className="extension-section" key={project.id}>
                      <div className="section-heading">
                        <h2>{project.name}</h2>
                        <span>
                          {project.sessions.length}
                          {copy.sectionHeadingLabel}
                        </span>
                      </div>
                      <code className="extension-path">{project.cwd}</code>
                      <div className="extension-list">
                        {project.sessions.map((session) => (
                          <article className="extension-card" key={session.id}>
                            <div className="extension-details">
                              <h3>{session.name}</h3>
                              <span className="extension-scope">
                                {session.tool} ·{" "}
                                {session.registered
                                  ? commonCopy.connected
                                  : session.status === "running"
                                    ? copy.extensionScope
                                    : commonCopy.ended}
                              </span>
                              {session.reason && <p>{session.reason}</p>}
                            </div>
                            <span className="agentbus-pending">
                              {session.pending || 0}
                              {copy.agentbusPending}
                            </span>
                          </article>
                        ))}
                      </div>
                      <button
                        className="button secondary"
                        onClick={() => onNavigate("messages", project.id)}
                      >
                        {copy.projectMessagesPrefix}
                        {project.name}
                        {copy.projectMessagesSuffix}
                      </button>
                    </section>
                  ))
                ) : (
                  <p className="extension-empty">{copy.noProjectMessages}</p>
                )}
              </>
            ) : (
              <>
                <label className="extension-profile">
                  {copy.extensionProfile}
                  <select
                    aria-label={copy.extensionProfile}
                    value={projectId || project?.id || ""}
                    onChange={(e) => onNavigate("messages", e.target.value)}
                  >
                    {!projects.length && <option value="">{copy.chooseProject}</option>}
                    {projectId && !project && (
                      <option value={projectId}>{copy.projectNotFound}</option>
                    )}
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.cwd}
                      </option>
                    ))}
                  </select>
                </label>
                {project ? (
                  <MessageLog
                    key={project.id}
                    request={request}
                    project={project}
                    page={page}
                    onPage={(next, replace = false) =>
                      onNavigate("messages", project.id, replace, next)
                    }
                  />
                ) : (
                  <p className="extension-empty">
                    {projectId ? copy.missingProjectDescription : copy.noProjects}
                  </p>
                )}
              </>
            )}
          </>
        )
      )}
    </div>
  );
}
