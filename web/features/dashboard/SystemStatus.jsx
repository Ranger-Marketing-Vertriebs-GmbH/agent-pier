import React, { lazy, Suspense, useState } from "react";
import { systemStatusCopy as copy } from "../../lib/i18n/messages/system-status.js";
import Icon from "../../components/Icon.jsx";
import useSystemStatus from "./useSystemStatus.js";
import { diskUsedPercent, statusBytes, statusPercent } from "./system-status-format.js";
import { DiskWarning, SystemMeter } from "./SystemMeter.jsx";
import LegacyTmuxNotice from "./LegacyTmuxNotice.jsx";

const SystemStatusDialog = lazy(() => import("./SystemStatusDialog.jsx"));

/** The start page's compact disk, CPU and RAM row; it opens the details. */
export default function SystemStatus({ navigate }) {
  const [open, setOpen] = useState(false);
  const { data, error } = useSystemStatus("/system-status", !open);
  // Optional information: without any figures yet, a failure hides the row quietly.
  if (error && !data) return null;
  return (
    <section className="system-status" aria-label={copy.title}>
      <DiskWarning status={data} />
      <LegacyTmuxNotice status={data?.legacyTmux} />
      <button
        type="button"
        className="system-status-row"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title={copy.rowLabel}
      >
        <span className="system-status-heading">
          <Icon name="grid" size={14} />
          {copy.title}
        </span>
        {data ? (
          <span className="system-status-meters">
            <SystemMeter
              label={copy.disk}
              percent={diskUsedPercent(data.disk)}
              value={copy.diskValue(
                statusBytes(data.disk.freeBytes),
                statusBytes(data.disk.totalBytes),
              )}
              tone={data.warning.diskLow ? "low" : ""}
            />
            <SystemMeter
              label={copy.cpu}
              percent={data.cpu.percent}
              value={copy.cpuValue(statusPercent(data.cpu.percent), data.cpu.cores)}
            />
            <SystemMeter
              label={copy.memory}
              percent={data.memory.percent}
              value={copy.usedValue(
                statusBytes(data.memory.usedBytes),
                statusBytes(data.memory.totalBytes),
              )}
            />
          </span>
        ) : (
          <span className="system-status-empty">{copy.loading}</span>
        )}
        <Icon name="chevron" size={16} />
      </button>
      {open && (
        <Suspense fallback={null}>
          <SystemStatusDialog close={() => setOpen(false)} openSession={navigate} />
        </Suspense>
      )}
    </section>
  );
}
