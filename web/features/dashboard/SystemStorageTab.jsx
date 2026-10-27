import React, { useState } from "react";
import { systemStatusCopy as copy } from "../../lib/i18n/messages/system-status.js";
import ShareBar from "../../components/ShareBar.jsx";
import StorageCleanup, { summaryGroups } from "./StorageCleanup.jsx";
import { DiskWarning } from "./SystemMeter.jsx";
import { statusBytes, statusPercent, statusTime } from "./system-status-format.js";

// Areas shown before "n more"; the rest folds.
const SHOWN = 8;
// The data directory area that holds each cleanup group's files.
const reclaimableIn = {
  backups: "updateBackups",
  profiles: "transcripts",
  agentWorkspaces: "dependencies",
};

function DriveCard({ data }) {
  const { disk, areas } = data;
  const agentPier = areas.state === "pending" ? null : areas.totalBytes;
  const used = Math.max(0, disk.usedBytes || 0);
  const value = copy.diskValue(statusBytes(disk.freeBytes), statusBytes(disk.totalBytes));
  return (
    <section className="system-status-card" aria-labelledby="system-status-drive">
      <div className="system-status-card-head">
        <h3 id="system-status-drive">{copy.driveHeading}</h3>
        <strong>{value}</strong>
      </div>
      <ShareBar
        label={value}
        total={disk.totalBytes}
        segments={[
          ...(agentPier === null
            ? []
            : [
                {
                  id: "agentpier",
                  label: copy.driveAgentPier(statusBytes(agentPier)),
                  value: Math.min(agentPier, used),
                  tone: "cpu",
                },
              ]),
          {
            id: "other",
            label: copy.driveOther(statusBytes(Math.max(0, used - (agentPier || 0)))),
            value: Math.max(0, used - (agentPier || 0)),
            tone: "other",
          },
          {
            id: "free",
            label: copy.driveFree(statusBytes(disk.freeBytes)),
            value: disk.freeBytes,
            tone: "free",
          },
        ]}
      />
      <p className="hint">
        {copy.driveNote(statusPercent(data.warning.thresholdPercent))}
      </p>
    </section>
  );
}

function DataCard({ areas, summary }) {
  const [all, setAll] = useState(false);
  const measured = summaryGroups(summary);
  if (areas.state === "pending")
    return (
      <section className="system-status-card" aria-labelledby="system-status-data">
        <h3 id="system-status-data">{copy.dataHeading}</h3>
        <p className="hint" role="status">
          {copy.dataPending}
        </p>
      </section>
    );
  const largest = Math.max(1, ...areas.areas.map((item) => item.bytes));
  const reclaimable = (item) =>
    Math.min(item.bytes, measured?.[reclaimableIn[item.id]]?.bytes || 0);
  const hidden = areas.areas.slice(SHOWN);
  const shown = all ? areas.areas : areas.areas.slice(0, SHOWN);
  return (
    <section className="system-status-card" aria-labelledby="system-status-data">
      <div className="system-status-card-head">
        <div className="system-status-total">
          <h3 id="system-status-data">{copy.dataHeading}</h3>
          <span>{copy.dataTotal(statusBytes(areas.totalBytes))}</span>
        </div>
        <small role="status">
          {areas.state === "refreshing"
            ? copy.dataRefreshing
            : copy.dataMeasured(statusTime(areas.computedAt))}
        </small>
      </div>
      {areas.partial && <p className="hint">{copy.dataPartial}</p>}
      {measured && (
        <ul className="share-bar-legend" aria-hidden="true">
          <li className="chart-tone-other">
            <i />
            {copy.dataUsed}
          </li>
          <li className="chart-tone-cpu">
            <i />
            {copy.dataReclaimable}
          </li>
        </ul>
      )}
      <ul className="system-area-list">
        {shown.map((item) => {
          const part = reclaimable(item);
          return (
            <li key={item.id}>
              <span>{copy.areas[item.id] || item.id}</span>
              <span className="system-area-bar" aria-hidden="true">
                <i style={{ width: `${(item.bytes / largest) * 100}%` }}>
                  {part > 0 && <b style={{ width: `${(part / item.bytes) * 100}%` }} />}
                </i>
              </span>
              <strong>
                {statusBytes(item.bytes)}
                {part > 0 && (
                  <span className="visually-hidden">
                    {` (${copy.reclaimable(statusBytes(part))})`}
                  </span>
                )}
              </strong>
            </li>
          );
        })}
      </ul>
      {hidden.length > 0 && (
        <button
          type="button"
          className="button secondary compact system-area-more"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all
            ? copy.dataFewer
            : copy.dataMore(
                hidden.length,
                statusBytes(hidden.reduce((sum, item) => sum + item.bytes, 0)),
              )}
        </button>
      )}
    </section>
  );
}

/**
 * System status › Storage: the drive, the data directory by area with the parts that
 * can be freed, and the clean-up panel.
 */
export default function SystemStorageTab({ data, summary }) {
  return (
    <div className="system-status-tab system-storage">
      <DiskWarning status={data} />
      <div className="system-storage-columns">
        <div className="system-storage-main">
          <DriveCard data={data} />
          <DataCard areas={data.areas} summary={summary} />
        </div>
        <StorageCleanup summary={summary} />
      </div>
    </div>
  );
}
