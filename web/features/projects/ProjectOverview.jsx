import React from "react";
import ProviderMark from "../../components/ProviderMark.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { projectOverviewCopy as copy } from "../../lib/i18n/messages/projects.js";
import { locale } from "../../lib/i18n/index.js";
import { names } from "../../lib/providers.js";

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

export default function ProjectOverview({ facts, sessions, select }) {
  return (
    <div className="project-overview">
      <dl className="project-facts" aria-label={copy.factsLabel}>
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd className={fact.mono ? "mono" : ""}>{fact.value}</dd>
          </div>
        ))}
      </dl>
      <h3 className="project-caps">{copy.sessions(sessions.length)}</h3>
      {sessions.length ? (
        <ul className="project-sessions">
          {sessions.map((session) => (
            <li key={session.id}>
              <ProviderMark tool={session.tool} small />
              <span className="project-session-name">
                <strong>{session.name}</strong>
                <small>
                  {[names[session.tool] || session.tool, relativeTime(session.createdAt)]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
              <span
                className={`project-session-status ${session.status === "running" ? "running" : ""}`}
              >
                <i aria-hidden="true" />
                {session.status === "running" ? commonCopy.running : commonCopy.ended}
              </span>
              <button
                type="button"
                className="button secondary compact"
                aria-label={copy.openSession(session.name)}
                onClick={() => select(session)}
              >
                {copy.open}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="project-empty">{copy.noSessions}</p>
      )}
    </div>
  );
}
