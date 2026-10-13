import React, { useId } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import Icon from "../../components/Icon.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { projectOverviewCopy as copy } from "../../lib/i18n/messages/projects.js";
import { locale } from "../../lib/i18n/index.js";
import { names } from "../../lib/providers.js";
import ProjectAttention from "./ProjectAttention.jsx";

const units = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];
export function relativeTime(value, now = Date.now()) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.round((time - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of units)
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return copy.justNow;
}

export default function ProjectOverview({
  projectId,
  facts,
  sessions,
  select,
  attention,
  onNavigate,
  mobile,
}) {
  const rowId = useId();
  const sessionsLabel = copy.sessions(sessions.length);
  return (
    <div className="project-overview">
      <ProjectAttention
        projectId={projectId}
        attention={attention}
        onNavigate={onNavigate}
      />
      <GroupLabel as={mobile ? "h2" : "h3"}>{copy.factsLabel}</GroupLabel>
      <dl className="list-card project-facts" aria-label={copy.factsLabel}>
        {facts.map((fact) => (
          <div key={fact.label} className="project-fact">
            <dt>{fact.label}</dt>
            <dd className={fact.mono ? "mono" : ""}>{fact.value}</dd>
          </div>
        ))}
      </dl>
      <GroupLabel as={mobile ? "h2" : "h3"}>{sessionsLabel}</GroupLabel>
      {sessions.length ? (
        <div
          className="list-card project-sessions"
          role="list"
          aria-label={sessionsLabel}
        >
          {sessions.map((session) => {
            const running = session.status === "running";
            const ids = `${rowId}-${session.id}`;
            return (
              <div className="list-row two-line" role="listitem" key={session.id}>
                <button
                  type="button"
                  className="list-row-main"
                  aria-label={copy.openSession(session.name)}
                  aria-describedby={`${ids}-sub ${ids}-status`}
                  onClick={() => select(session)}
                >
                  <ProviderMark tool={session.tool} small />
                  <span className="list-row-text">
                    <span className="list-row-label">{session.name}</span>
                    <span className="list-row-sub" id={`${ids}-sub`}>
                      {[
                        names[session.tool] || session.tool,
                        relativeTime(session.createdAt),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span
                    id={`${ids}-status`}
                    className={`project-session-status ${running ? "running" : ""}`}
                  >
                    <i aria-hidden="true" />
                    {running ? commonCopy.running : commonCopy.ended}
                  </span>
                  <Icon name="chevron" size={14} className="list-row-chevron" />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="project-empty">{copy.noSessions}</p>
      )}
    </div>
  );
}
