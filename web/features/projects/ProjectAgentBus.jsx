import React, { useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { projectAgentBusCopy as copy } from "../../lib/i18n/messages/agentbus.js";
import { projectOverviewCopy } from "../../lib/i18n/messages/projects.js";
import { names } from "../../lib/providers.js";
import MessageLog from "../agentbus/MessageLog.jsx";

// The AgentBus tab is scoped to this hub project's own AgentBus id. Status data comes
// from the hub's own /agentbus poll (passed in as props); only the messages segment
// keeps its own 4 s poll, and only while it is shown.
export default function ProjectAgentBus({
  request,
  project,
  busProjects,
  busVersion,
  busNote,
  busError,
  reloadBus,
  route,
  onNavigate,
}) {
  const busTab = route.busTab || "status";
  const busProject = busProjects.find((item) => item.id === project.busId) || null;
  const busProjectId = busProject?.id || "";
  const sessions = busProject?.sessions || [];
  const connected = sessions.filter((session) => session.registered).length;
  const pending = sessions.reduce((total, session) => total + (session.pending || 0), 0);
  const changeTab = (tab) => busTab !== tab && onNavigate(tab);
  // The segment's message count must agree with the message log's own total, not the
  // status poll's pending-inbox count. While the messages segment is shown, MessageLog
  // reports its own (already polling) total; otherwise a single one-shot read on mount
  // or project change keeps the count current without a second poll.
  const [messagesTotal, setMessagesTotal] = useState(0);
  useEffect(() => {
    if (!busProjectId || busTab === "messages") return;
    let active = true;
    request(`/agentbus/projects/${encodeURIComponent(busProjectId)}/messages?page=1`)
      .then((result) => {
        if (active) setMessagesTotal(result.total || 0);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [request, busProjectId, busTab]);
  return (
    <div className="project-agentbus">
      <div className="project-agentbus-toolbar">
        <div className="segment" role="tablist" aria-label={copy.tabsLabel}>
          <button
            type="button"
            role="tab"
            aria-selected={busTab === "status"}
            className={busTab === "status" ? "selected" : ""}
            onClick={() => changeTab("status")}
          >
            {projectOverviewCopy.sessions(sessions.length)}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={busTab === "messages"}
            className={busTab === "messages" ? "selected" : ""}
            onClick={() => changeTab("messages")}
          >
            {copy.messagesSegment(messagesTotal)}
          </button>
        </div>
        {busProject && (
          <p className="project-agentbus-status">
            {copy.connectedCount(connected)} · {copy.pendingCount(pending)} ·{" "}
            {copy.versionLabel(busVersion)}
          </p>
        )}
      </div>
      {busError && (
        <div className="extension-load-error">
          <ErrorMessage error={busError} as="p" />
          <button type="button" className="button secondary" onClick={reloadBus}>
            {commonCopy.reload}
          </button>
        </div>
      )}
      {busTab === "status" ? (
        busProject ? (
          <>
            {busNote && <p className="field-description">{busNote}</p>}
            <div className="project-agentbus-list">
              {sessions.map((session) => {
                const reloadRequired = session.reasonCode === "AGENTBUS_RELOAD_REQUIRED";
                const tone = reloadRequired
                  ? "decision"
                  : session.registered
                    ? "ok"
                    : "neutral";
                const label = reloadRequired
                  ? copy.reloadRequired
                  : session.registered
                    ? commonCopy.connected
                    : session.status === "running"
                      ? copy.waitingForSignIn
                      : commonCopy.ended;
                return (
                  <article className="project-agentbus-session" key={session.id}>
                    <div className="project-agentbus-session-details">
                      <h3>{session.name}</h3>
                      <div className="project-agentbus-session-meta">
                        <span>{names[session.tool] || session.tool}</span>
                        <StatusChip tone={tone}>{label}</StatusChip>
                      </div>
                      {reloadRequired ? (
                        <p>{copy.reloadRequiredDescription}</p>
                      ) : (
                        session.reason && <p>{session.reason}</p>
                      )}
                    </div>
                    <span className="agentbus-pending">
                      {session.pending || 0}
                      {copy.agentbusPending}
                    </span>
                  </article>
                );
              })}
            </div>
          </>
        ) : (
          <p className="project-empty">{copy.noProjectMessages}</p>
        )
      ) : busProject ? (
        <MessageLog
          key={busProject.id}
          request={request}
          project={busProject}
          page={route.messagePage || 1}
          onTotal={setMessagesTotal}
          onPage={(next, replace = false) => onNavigate("messages", next, replace)}
        />
      ) : (
        <p className="project-empty">{copy.missingProjectDescription}</p>
      )}
    </div>
  );
}
