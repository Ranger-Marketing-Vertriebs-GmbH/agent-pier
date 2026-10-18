import React from "react";
import { systemStatusCopy as copy } from "../../lib/i18n/messages/system-status.js";
import Modal from "../../components/Modal.jsx";
import useSystemStatus from "./useSystemStatus.js";
import { DiskWarning, SystemMeter } from "./SystemMeter.jsx";
import {
  clampPercent,
  statusBytes,
  statusNumber,
  statusPercent,
  statusTime,
} from "./system-status-format.js";

const WIDTH = 240,
  HEIGHT = 44,
  HOUR = 60 * 60 * 1000,
  // Points further apart than this mark a time nobody looked; the line breaks there.
  GAP = 90 * 1000;

/** One series of the last hour as SVG polylines, with a text value for readers. */
export function Sparkline({ name, points, field, now }) {
  const segments = [];
  let segment = [];
  let previous;
  for (const point of points) {
    if (!Number.isFinite(point[field])) {
      segments.push(segment);
      segment = [];
      previous = null;
      continue;
    }
    if (previous && point.t - previous.t > GAP) {
      segments.push(segment);
      segment = [];
    }
    const x = Math.max(0, WIDTH - ((now - point.t) / HOUR) * WIDTH);
    const y = HEIGHT - (clampPercent(point[field]) / 100) * (HEIGHT - 2) - 1;
    segment.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    previous = point;
  }
  segments.push(segment);
  const last = points.at(-1)?.[field];
  return (
    <figure className="system-sparkline">
      <figcaption>
        <span>{name}</span>
        <strong>{statusPercent(last)}</strong>
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={copy.historyLabel(name, statusPercent(last))}
      >
        {segments
          .filter((items) => items.length)
          .map((items, index) =>
            items.length === 1 ? (
              <circle
                key={index}
                cx={items[0].split(",")[0]}
                cy={items[0].split(",")[1]}
                r="1.5"
              />
            ) : (
              <polyline key={index} points={items.join(" ")} />
            ),
          )}
      </svg>
    </figure>
  );
}

function processLabel(item) {
  if (item.kind === "server") return copy.server;
  if (item.kind === "gateway") return copy.gateway;
  return copy.session(item.name);
}

export default function SystemStatusDialog({ close }) {
  const { data, error } = useSystemStatus("/system-status/details");
  const now = data ? Date.parse(data.sampledAt) : Date.now();
  const largest = Math.max(1, ...(data?.areas?.areas || []).map((item) => item.bytes));
  const sessions = data?.processes.filter((item) => item.kind === "session") || [];
  return (
    <Modal
      title={copy.title}
      close={close}
      wide
      footer={null}
      className="system-status-dialog"
    >
      <div className="system-status-details">
        {!data ? (
          <p className="system-status-empty" role="status">
            {error ? copy.unavailable : copy.loading}
          </p>
        ) : (
          <>
            <DiskWarning status={data} />
            <section aria-labelledby="system-status-host">
              <h3 id="system-status-host">{copy.hostHeading}</h3>
              <div className="system-status-meters">
                <SystemMeter
                  label={copy.disk}
                  percent={100 - data.disk.freePercent}
                  value={copy.diskValue(
                    statusBytes(data.disk.freeBytes),
                    statusBytes(data.disk.totalBytes),
                  )}
                  tone={data.warning.diskLow ? "low" : ""}
                />
                <SystemMeter
                  label={copy.cpu}
                  percent={data.cpu.percent}
                  value={copy.load(...data.cpu.load.map((value) => statusNumber(value)))}
                />
                <SystemMeter
                  label={copy.memory}
                  percent={data.memory.percent}
                  value={copy.usedValue(
                    statusBytes(data.memory.usedBytes),
                    statusBytes(data.memory.totalBytes),
                  )}
                />
              </div>
            </section>
            <section aria-labelledby="system-status-history">
              <h3 id="system-status-history">{copy.historyHeading}</h3>
              <div className="system-sparklines">
                <Sparkline
                  name={copy.historyCpu}
                  points={data.history}
                  field="cpu"
                  now={now}
                />
                <Sparkline
                  name={copy.historyMemory}
                  points={data.history}
                  field="memory"
                  now={now}
                />
                <Sparkline
                  name={copy.historyAgentPier}
                  points={data.history}
                  field="agentCpu"
                  now={now}
                />
              </div>
              {data.history.length < 3 && <p className="hint">{copy.historyEmpty}</p>}
            </section>
            <section aria-labelledby="system-status-share">
              <h3 id="system-status-share">{copy.shareHeading}</h3>
              <p className="system-status-total">
                {copy.shareTotal(
                  statusPercent(data.agentPier.cpuPercent, 1),
                  statusBytes(data.agentPier.rssBytes),
                )}
              </p>
              <table className="system-process-table">
                <thead>
                  <tr>
                    <th scope="col">{copy.processName}</th>
                    <th scope="col">{copy.processCount}</th>
                    <th scope="col">{copy.processCpu}</th>
                    <th scope="col">{copy.processMemory}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.processes.map((item) => (
                    <tr key={item.id || item.kind}>
                      <th scope="row">
                        {processLabel(item)}
                        {item.kind === "session" && item.tool && (
                          <small>{copy.sessionTool[item.tool] || item.tool}</small>
                        )}
                      </th>
                      <td>{item.processes}</td>
                      <td>{statusPercent(item.cpuPercent, 1)}</td>
                      <td>{statusBytes(item.rssBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!sessions.length && <p className="hint">{copy.noSessions}</p>}
              <p className="hint">{copy.cpuNote}</p>
            </section>
            <section aria-labelledby="system-status-data">
              <h3 id="system-status-data">{copy.dataHeading}</h3>
              {data.areas.state === "pending" ? (
                <p className="hint" role="status">
                  {copy.dataPending}
                </p>
              ) : (
                <>
                  <p className="system-status-total">
                    {copy.dataTotal(statusBytes(data.areas.totalBytes))}
                    <small>
                      {data.areas.state === "refreshing"
                        ? copy.dataRefreshing
                        : copy.dataMeasured(statusTime(data.areas.computedAt))}
                    </small>
                  </p>
                  {data.areas.partial && <p className="hint">{copy.dataPartial}</p>}
                  <ul className="system-area-list">
                    {data.areas.areas.map((item) => (
                      <li key={item.id}>
                        <span>{copy.areas[item.id] || item.id}</span>
                        <strong>{statusBytes(item.bytes)}</strong>
                        <div className="system-meter-bar" aria-hidden="true">
                          <i style={{ width: `${(item.bytes / largest) * 100}%` }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
