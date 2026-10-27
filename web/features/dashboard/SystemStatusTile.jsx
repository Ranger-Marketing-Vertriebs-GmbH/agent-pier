import React from "react";
import Icon from "../../components/Icon.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import { sparklinePaths } from "../../components/history-chart.js";
import { startPageCopy as copy } from "../../lib/i18n/messages/dashboard.js";
import { systemStatusCopy } from "../../lib/i18n/messages/system-status.js";
import { SystemMeter } from "./SystemMeter.jsx";
import {
  clampPercent,
  diskUsedPercent,
  statusBytes,
  statusPercent,
} from "./system-status-format.js";

const WIDTH = 120;
const HEIGHT = 28;

function Sparkline({ points, field, tone }) {
  const paths = sparklinePaths(points, field, WIDTH, HEIGHT);
  return (
    <svg
      className={`start-sparkline ${tone}`}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

function Figure({ label, side, percent, tone, points, field }) {
  return (
    <span className={`start-figure ${tone}`}>
      <span className="start-figure-top">
        <span>{label}</span>
        <small>{side}</small>
      </span>
      <strong>{statusPercent(percent)}</strong>
      <Sparkline points={points} field={field} tone={tone} />
    </span>
  );
}

/**
 * The start page's system status: CPU and RAM with sparklines, the disk and
 * AgentPier's share. The whole tile is one button that opens the details. Without
 * figures yet a failure hides it quietly; phones show three small bars.
 */
export default function SystemStatusTile({ data, error, onOpen, phone }) {
  if (error && !data) return null;
  const history = Array.isArray(data?.history) ? data.history : [];
  const diskTone = data?.warning.diskLow ? "low" : "";
  return (
    <button
      type="button"
      className={`start-card start-system ${phone ? "phone" : ""}`}
      onClick={onOpen}
      aria-haspopup="dialog"
      title={systemStatusCopy.rowLabel}
    >
      <span className="start-card-head">
        <span className="start-system-title">{systemStatusCopy.title}</span>
        {data && !error && !phone && (
          <StatusChip tone="ok">{systemStatusCopy.live}</StatusChip>
        )}
        {phone && <Icon name="chevron" size={16} />}
      </span>
      {!data ? (
        <span className="start-empty">{systemStatusCopy.loading}</span>
      ) : phone ? (
        <span className="system-status-meters">
          <SystemMeter label={systemStatusCopy.cpu} percent={data.cpu.percent} />
          <SystemMeter
            label={systemStatusCopy.memory}
            percent={data.memory.percent}
            tone="memory"
          />
          <SystemMeter
            label={systemStatusCopy.disk}
            percent={diskUsedPercent(data.disk)}
            tone={diskTone || "disk"}
          />
        </span>
      ) : (
        <>
          <span className="start-figures">
            <Figure
              label={systemStatusCopy.cpu}
              side={copy.systemCores(data.cpu.cores)}
              percent={data.cpu.percent}
              tone="cpu"
              points={history}
              field="cpu"
            />
            <Figure
              label={systemStatusCopy.memory}
              side={copy.systemMemory(
                statusBytes(data.memory.usedBytes),
                statusBytes(data.memory.totalBytes),
              )}
              percent={data.memory.percent}
              tone="memory"
              points={history}
              field="memory"
            />
          </span>
          <span className={`start-disk ${diskTone}`}>
            <span className="start-figure-top">
              <span>{systemStatusCopy.disk}</span>
              <small>
                {/* An unknown free share stays unknown, as on the bars. */}
                {Number.isFinite(data.disk.freePercent)
                  ? systemStatusCopy.diskValue(
                      statusBytes(data.disk.freeBytes),
                      statusBytes(data.disk.totalBytes),
                    )
                  : statusPercent(null)}
              </small>
            </span>
            <span className="system-meter-bar" aria-hidden="true">
              <i style={{ width: `${clampPercent(diskUsedPercent(data.disk))}%` }} />
            </span>
          </span>
          <span className="start-system-foot">
            <span>
              {copy.systemAgentPier(
                statusPercent(data.agentPier.cpuPercent, 1),
                statusBytes(data.agentPier.rssBytes),
              )}
            </span>
            <span className="start-head-link">
              {copy.systemDetails}
              <Icon name="chevron" size={14} />
            </span>
          </span>
        </>
      )}
    </button>
  );
}
