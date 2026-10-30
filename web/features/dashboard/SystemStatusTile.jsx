import React from "react";
import Icon from "../../components/Icon.jsx";
import Skeleton, { SkeletonLabel } from "../../components/Skeleton.jsx";
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

// The tile's figures as skeletons, in the same places and sizes.
function SkeletonFigures({ phone }) {
  if (phone)
    return (
      <span className="system-status-meters">
        {[systemStatusCopy.cpu, systemStatusCopy.memory, systemStatusCopy.disk].map(
          (label) => (
            <span key={label} className="system-meter">
              <span className="system-meter-top">
                <span>{label}</span>
                <strong>
                  <Skeleton width="2.2em" />
                </strong>
              </span>
              <span className="system-meter-bar" aria-hidden="true" />
              <small>
                <Skeleton width="60%" />
              </small>
            </span>
          ),
        )}
      </span>
    );
  return (
    <>
      <span className="start-figures">
        {[systemStatusCopy.cpu, systemStatusCopy.memory].map((label) => (
          <span key={label} className="start-figure">
            <span className="start-figure-top">
              <span>{label}</span>
              <small>
                <Skeleton width="5em" />
              </small>
            </span>
            <strong>
              <Skeleton width="2.4em" />
            </strong>
            <Skeleton shape="block" width="100%" height="28px" />
          </span>
        ))}
      </span>
      <span className="start-disk">
        <span className="start-figure-top">
          <span>{systemStatusCopy.disk}</span>
          <small>
            <Skeleton width="9em" />
          </small>
        </span>
        <span className="system-meter-bar" aria-hidden="true" />
      </span>
      <span className="start-system-foot">
        <span>
          <Skeleton width="14em" />
        </span>
        <span className="start-head-link">
          {copy.systemDetails}
          <Icon name="chevron" size={14} />
        </span>
      </span>
    </>
  );
}

/**
 * The start page's system status: CPU and RAM with sparklines, the disk and
 * AgentPier's share. The whole tile is one button that opens the details. Skeleton
 * figures hold their place until the first figures arrive; a failure before any
 * arrived says the status is unavailable. Phones show three small bars.
 */
export default function SystemStatusTile({ data, error, onOpen, phone }) {
  const failed = Boolean(error && !data);
  const history = Array.isArray(data?.history) ? data.history : [];
  const diskTone = data?.warning.diskLow ? "low" : "";
  return (
    <button
      type="button"
      className={`start-card start-system ${phone ? "phone" : ""}`}
      onClick={onOpen}
      aria-haspopup="dialog"
      title={systemStatusCopy.rowLabel}
      aria-busy={(!data && !failed) || undefined}
    >
      <span className="start-card-head">
        <span className="start-system-title">{systemStatusCopy.title}</span>
        {data && !error && !phone && (
          <StatusChip tone="ok">{systemStatusCopy.live}</StatusChip>
        )}
        {!data && !failed && !phone && (
          <span className="status-chip">
            <Skeleton width="7em" />
          </span>
        )}
        {phone && <Icon name="chevron" size={16} />}
      </span>
      {failed ? (
        <span className="start-empty">{systemStatusCopy.unavailable}</span>
      ) : !data ? (
        <>
          <SkeletonLabel />
          <SkeletonFigures phone={phone} />
        </>
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
