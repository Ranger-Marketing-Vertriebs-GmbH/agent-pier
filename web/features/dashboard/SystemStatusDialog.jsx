import React, { useState } from "react";
import { systemStatusCopy as copy } from "../../lib/i18n/messages/system-status.js";
import Modal from "../../components/Modal.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import useSystemStatus from "./useSystemStatus.js";
import { CLEANUP_API } from "./useCleanup.jsx";
import { summaryGroups } from "./StorageCleanup.jsx";
import SystemLoadTab from "./SystemLoadTab.jsx";
import SystemProcessesTab from "./SystemProcessesTab.jsx";
import SystemStorageTab from "./SystemStorageTab.jsx";
import { statusBytes, usableCleanupSummary } from "./system-status-format.js";

const ID = "system-status";

// The details tolerate a missing part, such as process rows after a failed ps.
function details(answer) {
  return (
    answer && {
      ...answer,
      processes: Array.isArray(answer.processes) ? answer.processes : [],
      history: Array.isArray(answer.history) ? answer.history : [],
      areas: Array.isArray(answer.areas?.areas) ? answer.areas : { state: "pending" },
    }
  );
}

// "This computer · 16 cores · 64 GB RAM · macOS"; the platform only when known.
function hostFacts(data) {
  const platform = data.host?.platform;
  return [
    copy.host.computer,
    copy.host.cores(data.cpu.cores),
    copy.host.memory(statusBytes(data.memory.totalBytes)),
    platform && (copy.host.platforms[platform] || platform),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The system status in three tabs: Load, Processes and Storage. `cleanup` (Settings ›
 * Operations › Storage) opens the Storage tab. `openSession(route)` navigates to a
 * session; the dialog closes first.
 */
export default function SystemStatusDialog({ close, cleanup = false, openSession }) {
  const [tab, setTab] = useState(cleanup ? "storage" : "load");
  const { data: answer, error } = useSystemStatus(`/${ID}/details`);
  const { data: summary } = useSystemStatus(
    `${CLEANUP_API}/summary`,
    true,
    usableCleanupSummary,
  );
  const data = details(answer);
  const measured = summaryGroups(summary);
  const reclaimable = measured
    ? Object.values(measured).reduce((sum, group) => sum + (group?.bytes || 0), 0)
    : null;
  const tabs = [
    { id: "load", label: copy.tabs.load },
    {
      id: "processes",
      label: copy.tabs.processes,
      count: data
        ? data.processes.reduce((sum, item) => sum + (item.processes || 0), 0)
        : undefined,
    },
    {
      id: "storage",
      label: (
        <>
          {copy.tabs.storage}
          {data?.warning.diskLow && (
            <StatusDot tone="warning" label={copy.diskLowTitle} />
          )}
        </>
      ),
      count:
        reclaimable === null ? undefined : copy.reclaimable(statusBytes(reclaimable)),
    },
  ];
  const panel = {
    load: () => <SystemLoadTab data={data} showProcesses={() => setTab("processes")} />,
    processes: () => (
      <SystemProcessesTab
        data={data}
        openSession={
          openSession &&
          ((route) => {
            close();
            openSession(route);
          })
        }
      />
    ),
    storage: () => <SystemStorageTab data={data} summary={summary} />,
  }[tab];
  return (
    <Modal
      title={copy.title}
      close={close}
      wide
      footer={null}
      className="system-status-dialog"
    >
      <div className="system-status-details">
        <div className="system-status-head">
          <p>{data ? hostFacts(data) : ""}</p>
          <StatusChip tone="ok" pill>
            {copy.live}
          </StatusChip>
        </div>
        <UnderlineTabs
          label={copy.tabsLabel}
          tabs={tabs}
          selected={tab}
          onSelect={setTab}
          idPrefix={ID}
        />
        <div
          role="tabpanel"
          id={`${ID}-tabpanel-${tab}`}
          aria-labelledby={`${ID}-tab-${tab}`}
          className="system-status-panel"
        >
          {data ? (
            panel()
          ) : (
            <p className="system-status-empty" role="status">
              {error ? copy.unavailable : copy.loading}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
