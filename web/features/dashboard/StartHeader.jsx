import React from "react";
import Icon from "../../components/Icon.jsx";
import PageHeader from "../../components/PageHeader.jsx";
import { locale } from "../../lib/i18n/index.js";
import { startPageCopy as copy } from "../../lib/i18n/messages/dashboard.js";
import { greetingOf, summaryParts } from "./start-header.js";

/**
 * "Overview · Tuesday, 27 October", a greeting by the time of day and what is going
 * on; New agent (while agents are on) and New session, which stays disabled while no
 * CLI is installed.
 */
export default function StartHeader({
  counts,
  agentsEnabled,
  installed,
  launch,
  navigate,
  phone,
}) {
  const now = new Date();
  const date = now.toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const parts = summaryParts(counts);
  const known = counts.sessions !== null && counts.attention !== null;
  return (
    <PageHeader
      className="start-header"
      eyebrow={phone ? copy.overview : copy.eyebrow(date)}
      title={copy.greeting[greetingOf(now.getHours())]}
      summary={
        parts.length ? (
          <p>
            {parts.map((part, index) => (
              <React.Fragment key={part.id}>
                {index > 0 && " · "}
                <span className={part.tone === "accent" ? "start-accent" : undefined}>
                  {copy.summary[part.id](part.count)}
                </span>
              </React.Fragment>
            ))}
          </p>
        ) : known ? (
          <p>{copy.calm}</p>
        ) : null
      }
      actions={
        <>
          {agentsEnabled && (
            <button
              type="button"
              className="button secondary"
              onClick={() => navigate({ view: "agents", creating: true })}
            >
              <Icon name={phone ? "plus" : "users"} size={16} />
              {phone ? copy.newAgentShort : copy.newAgent}
            </button>
          )}
          <button
            type="button"
            className="button primary start-new-session"
            onClick={() => launch()}
            disabled={!installed}
          >
            <Icon name="plus" size={16} />
            {phone ? copy.newSessionShort : copy.newSession}
          </button>
        </>
      }
    />
  );
}
