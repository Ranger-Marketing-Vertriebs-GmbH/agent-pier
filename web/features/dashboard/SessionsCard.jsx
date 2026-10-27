import React from "react";
import Icon from "../../components/Icon.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { activityTone } from "../../components/status-tones.js";
import { isPlainClick } from "../../components/link-click.js";
import { routePath } from "../../app/routes.js";
import { startPageCopy as copy } from "../../lib/i18n/messages/dashboard.js";
import { systemStatusCopy } from "../../lib/i18n/messages/system-status.js";
import StartListCard from "./StartListCard.jsx";
import { sessionFilters, sessionItems, SESSION_LIMIT } from "./start-lists.js";
import { shortSpan } from "./start-header.js";
import { statusBytes, statusPercent } from "./system-status-format.js";

const sessionRoute = (id) => ({ view: "workspace", sessionId: id, mode: null });
const toolName = (tool) => systemStatusCopy.sessionTool[tool] || tool;
const dots = {
  waiting: "waiting",
  working: "working",
  ready: "idle",
  stopped: "pending",
};

/** A short span in words ("3 min", "just now"); "" while unknown. */
export function spanText(then, now = Date.now()) {
  const span = shortSpan(then, now);
  if (!span) return "";
  return span.unit === "now" ? copy.span.now : copy.span[span.unit](span.value);
}

/** "for 3 min" while working, else "2 min ago"; nothing while the time is unknown. */
export function stateTime(item, now = Date.now()) {
  if (item.state === "stopped") return "";
  const text = spanText(item.time, now);
  if (!text || text === copy.span.now) return text;
  return item.state === "working" ? copy.since(text) : copy.ago(text);
}

function SessionLink({ item, navigate, className, children, label }) {
  const route = sessionRoute(item.id);
  return (
    <a
      className={className}
      href={routePath(route)}
      aria-label={label}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        navigate(route);
      }}
    >
      {children}
    </a>
  );
}

function Table({ rows, figures, navigate }) {
  const now = Date.now();
  return (
    <table className="start-table">
      <thead>
        <tr>
          <th scope="col">{copy.columns.session}</th>
          <th scope="col">{copy.columns.state}</th>
          <th scope="col" className="numeric">
            {copy.columns.cpu}
          </th>
          <th scope="col" className="numeric">
            {copy.columns.memory}
          </th>
          <th scope="col">
            <span className="visually-hidden">{copy.columns.open}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((item) => {
          const usage = figures.get(item.id);
          const name = item.session.name || item.id;
          return (
            <tr key={item.id} className={`start-session-${item.state}`}>
              <th scope="row">
                <span className="start-row-main">
                  <ProviderMark tool={item.session.tool} size="row" />
                  <span className="start-row-text">
                    <strong>{name}</strong>
                    <small>
                      {[item.project, toolName(item.session.tool)]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </span>
                </span>
              </th>
              <td>
                <span className={`start-state ${item.state}`}>
                  <StatusDot tone={activityTone(item.state)} />
                  {item.label}
                </span>
                <small className="start-state-time">{stateTime(item, now)}</small>
              </td>
              <td className="numeric">
                {usage ? statusPercent(usage.cpuPercent, 1) : "–"}
              </td>
              <td className="numeric">{usage ? statusBytes(usage.rssBytes) : "–"}</td>
              <td className="start-open">
                <SessionLink
                  item={item}
                  navigate={navigate}
                  className="icon-button start-open-button"
                  label={copy.openSession(name)}
                >
                  <Icon name="arrow" size={16} />
                </SessionLink>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PhoneRows({ rows, navigate }) {
  const now = Date.now();
  return (
    <ul className="start-rows">
      {rows.map((item) => (
        <li key={item.id}>
          <SessionLink item={item} navigate={navigate} className="start-row">
            <ProviderMark tool={item.session.tool} size="row" />
            <span className="start-row-text">
              <strong>{item.session.name || item.id}</strong>
              <small>
                {[item.project, stateTime(item, now)].filter(Boolean).join(" · ")}
              </small>
            </span>
            <span className={`start-state ${item.state}`}>
              <StatusDot tone={activityTone(item.state)} />
              {item.label}
            </span>
          </SessionLink>
        </li>
      ))}
    </ul>
  );
}

/**
 * Sessions with their state, since when, CPU and RAM (`figures` from the system
 * status summary, by session id) and Open. Waiting sessions come first.
 */
export default function SessionsCard({
  sessions,
  figures = [],
  navigate,
  openNavigation,
  phone,
}) {
  const items = sessionItems(sessions, toolName);
  const running = items.filter((item) => item.state !== "stopped").length;
  const usage = new Map(figures.map((item) => [item.id, item]));
  return (
    <StartListCard
      id="start-sessions"
      className="start-sessions"
      title={copy.sessions}
      count={items.length ? copy.sessionsCount(running, items.length - running) : null}
      items={items}
      filters={sessionFilters}
      filterLabels={copy.sessionFilters}
      filterDots={dots}
      chipsLabel={copy.sessionsFilter}
      searchLabel={copy.sessionsSearch}
      limit={SESSION_LIMIT}
      order={copy.sessionOrder}
      empty={copy.noSessions}
      noMatch={copy.noSessionMatch}
      phone={phone}
      showAll={
        openNavigation &&
        ((count) => ({ label: copy.showAllSessions(count), onClick: openNavigation }))
      }
    >
      {(rows) =>
        phone ? (
          <PhoneRows rows={rows} navigate={navigate} />
        ) : (
          <Table rows={rows} figures={usage} navigate={navigate} />
        )
      }
    </StartListCard>
  );
}
