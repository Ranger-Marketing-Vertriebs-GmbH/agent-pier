import React, { useState } from "react";
import { systemStatusCopy as copy } from "../../lib/i18n/messages/system-status.js";
import Icon from "../../components/Icon.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import Segment from "../../components/Segment.jsx";
import { isPlainClick } from "../../components/link-click.js";
import { routePath } from "../../app/routes.js";
import useMobileLayout from "../../lib/useMobileLayout.js";
import { PROCESS_SORTS, processGroups } from "./system-processes.js";
import { statusBytes, statusPercent } from "./system-status-format.js";

export function processLabel(item) {
  if (item.kind === "server") return copy.server;
  if (item.kind === "gateway") return copy.gateway;
  return copy.session(item.name);
}

function processSub(item) {
  if (item.kind === "server") return copy.serverSub;
  if (item.kind === "gateway") return copy.gatewaySub;
  const tool = copy.sessionTool[item.tool] || item.tool;
  return [tool, item.project].filter(Boolean).join(" · ");
}

const sessionRoute = (id) => ({ view: "workspace", sessionId: id, mode: null });

function Mark({ item }) {
  if (item.kind === "session") return <ProviderMark tool={item.tool} size="row" />;
  return (
    <span className="system-process-mark" aria-hidden="true">
      <Icon name="grid" size={14} />
    </span>
  );
}

function Bar({ value, largest, tone }) {
  const width = largest > 0 ? Math.min(100, (Math.max(0, value) / largest) * 100) : 0;
  return (
    <span className={`system-process-bar ${tone}`} aria-hidden="true">
      <i style={{ width: `${width}%` }} />
    </span>
  );
}

function OpenLink({ item, openSession }) {
  if (item.kind !== "session" || !item.id || !openSession) return null;
  return (
    <a
      className="system-process-open"
      href={routePath(sessionRoute(item.id))}
      aria-label={copy.openSessionLabel(processLabel(item))}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        openSession(sessionRoute(item.id));
      }}
    >
      {copy.openSession}
    </a>
  );
}

/**
 * System status › Processes: AgentPier's total, then the core and the sessions as
 * row groups with subtotals, sorted by CPU, RAM or name. `openSession(route)` closes
 * the dialog and selects the session.
 */
export default function SystemProcessesTab({ data, openSession }) {
  const [sort, setSort] = useState("cpu");
  const phone = useMobileLayout();
  const { core, sessions, largest } = processGroups(data.processes, sort, processLabel);
  const groups = [
    { id: "core", label: copy.groupCore, ...core },
    { id: "sessions", label: copy.groupSessions(sessions.rows.length), ...sessions },
  ];
  const labels = {
    cpu: copy.processCpu,
    memory: copy.processMemory,
    name: copy.processSortName,
  };
  const ariaSort = (column) =>
    sort === column ? (column === "name" ? "ascending" : "descending") : undefined;
  return (
    <div className="system-status-tab system-processes">
      <div className="system-processes-top">
        <dl className="system-process-tiles">
          <div className="system-status-card">
            <dt>{copy.processTotalCpu}</dt>
            <dd className="cpu">{statusPercent(data.agentPier.cpuPercent, 1)}</dd>
          </div>
          <div className="system-status-card">
            <dt>{copy.processMemory}</dt>
            <dd className="memory">{statusBytes(data.agentPier.rssBytes)}</dd>
          </div>
          <div className="system-status-card">
            <dt>{copy.processCount}</dt>
            <dd>{core.processes + sessions.processes}</dd>
          </div>
        </dl>
        <div className="system-process-sort">
          <span aria-hidden="true">{copy.processSort}</span>
          <Segment
            label={copy.processSort}
            value={sort}
            onChange={setSort}
            options={PROCESS_SORTS.map((value) => ({ value, label: labels[value] }))}
          />
        </div>
      </div>
      {phone ? (
        <div className="system-process-cards">
          {groups.map((group) => (
            <section key={group.id} aria-label={group.label}>
              <h4>
                {group.label}
                <span>
                  {statusPercent(group.cpuPercent, 1)} · {statusBytes(group.rssBytes)}
                </span>
              </h4>
              <ul>
                {group.rows.map((item) => (
                  <li key={item.id || item.kind} className="system-status-card">
                    <Mark item={item} />
                    <div className="system-process-card-text">
                      <strong>{processLabel(item)}</strong>
                      <small>
                        {[processSub(item), copy.processes(item.processes)]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                      <Bar
                        value={item.cpuPercent}
                        largest={largest.cpuPercent}
                        tone="cpu"
                      />
                    </div>
                    <div className="system-process-card-values">
                      <span className="cpu">{statusPercent(item.cpuPercent, 1)}</span>
                      <span className="memory">{statusBytes(item.rssBytes)}</span>
                      <OpenLink item={item} openSession={openSession} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <div className="system-status-card system-process-frame">
          <table className="system-process-table">
            <thead>
              <tr>
                <th scope="col" aria-sort={ariaSort("name")}>
                  {copy.processName}
                </th>
                <th scope="col">{copy.processCount}</th>
                <th scope="col" aria-sort={ariaSort("cpu")}>
                  {copy.processCpu}
                </th>
                <th scope="col" aria-sort={ariaSort("memory")}>
                  {copy.processMemory}
                </th>
                <th scope="col">
                  <span className="visually-hidden">{copy.processActions}</span>
                </th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.id}>
                <tr className="system-process-group">
                  <th scope="rowgroup" colSpan={2}>
                    {group.label}
                  </th>
                  <td>{statusPercent(group.cpuPercent, 1)}</td>
                  <td>{statusBytes(group.rssBytes)}</td>
                  <td />
                </tr>
                {group.rows.map((item) => (
                  <tr key={item.id || item.kind}>
                    <th scope="row">
                      <span className="system-process-name">
                        <Mark item={item} />
                        <span>
                          {processLabel(item)}
                          <small>{processSub(item)}</small>
                        </span>
                      </span>
                    </th>
                    <td>{item.processes}</td>
                    <td>
                      <span className="system-process-value">
                        <Bar
                          value={item.cpuPercent}
                          largest={largest.cpuPercent}
                          tone="cpu"
                        />
                        {statusPercent(item.cpuPercent, 1)}
                      </span>
                    </td>
                    <td>
                      <span className="system-process-value">
                        <Bar
                          value={item.rssBytes}
                          largest={largest.rssBytes}
                          tone="memory"
                        />
                        {statusBytes(item.rssBytes)}
                      </span>
                    </td>
                    <td>
                      <OpenLink item={item} openSession={openSession} />
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
      {!sessions.rows.length && <p className="hint">{copy.noSessions}</p>}
      <p className="hint">{copy.cpuNote}</p>
    </div>
  );
}
