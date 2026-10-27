import React, { useId, useState } from "react";
import { systemStatusCopy as copy } from "../../lib/i18n/messages/system-status.js";
import { usePageAction } from "../../app/page-action.js";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import CleanupSnapshots from "./CleanupSnapshots.jsx";
import CleanupTranscripts from "./CleanupTranscripts.jsx";
import CleanupDependencies from "./CleanupDependencies.jsx";
import { cleanupSize } from "./useCleanup.jsx";
import { statusBytes, statusDate } from "./system-status-format.js";

// Each list, the summary group that sizes it and its facts line.
const groups = [
  {
    id: "snapshots",
    summary: "updateBackups",
    List: CleanupSnapshots,
    facts: (group) =>
      group.count
        ? copy.cleanup.snapshots.facts(group.count, statusDate(group.oldestAt))
        : copy.cleanup.snapshots.empty,
  },
  {
    id: "transcripts",
    summary: "transcripts",
    List: CleanupTranscripts,
    facts: (group) =>
      group.count
        ? copy.cleanup.transcripts.facts(group.count, group.olderThanDays, group.profiles)
        : copy.cleanup.transcripts.none,
  },
  {
    id: "dependencies",
    summary: "dependencies",
    List: CleanupDependencies,
    facts: (group) =>
      group.count
        ? copy.cleanup.dependencies.facts(group.count, group.agents)
        : copy.cleanup.dependencies.empty,
  },
];

/** The summary's groups once measured, else null. */
export const summaryGroups = (summary) =>
  summary && summary.state !== "pending" && summary.groups ? summary.groups : null;

/**
 * What stands in for a size the summary does not know: "Updating sizes …" while it is
 * measured, "Measured on open" only once it failed or cannot be read.
 */
export const unmeasured = (summary) =>
  summary?.state === "failed" ? copy.cleanup.measuredOnOpen : copy.dataRefreshing;

/**
 * One cleanup list behind its row; also on Agenten › Laufzeit › Speicher. `action`
 * names the page action (⌘K) that opens it.
 */
export function CleanupGroup({ id, List, action = "" }) {
  const [open, setOpen] = useState(false);
  usePageAction(action, () => setOpen(true), Boolean(action));
  const panel = useId();
  const text = copy.cleanup[id];
  return (
    <div className="system-cleanup-group">
      <ListCard label={text.title}>
        <ListRow label={text.title} sub={text.sub}>
          <button
            type="button"
            className="button secondary compact"
            aria-expanded={open}
            aria-controls={panel}
            aria-label={`${text.title}: ${copy.cleanup.open}`}
            onClick={() => setOpen(!open)}
          >
            {copy.cleanup.open}
          </button>
        </ListRow>
      </ListCard>
      <div id={panel} hidden={!open} className="system-cleanup-panel">
        {open && <List />}
      </div>
    </div>
  );
}

// One group of the panel: its size from the summary, and its list on request.
function CleanupCard({ id, List, group, facts, unknown }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const heading = useId();
  const text = copy.cleanup[id];
  return (
    <article className="system-cleanup-card" aria-labelledby={heading}>
      <div className="system-cleanup-card-head">
        <h4 id={heading}>{text.title}</h4>
        <strong className={group ? "" : "pending"}>
          {group ? cleanupSize(group.bytes, group.atLeast) : unknown}
        </strong>
      </div>
      <p>{text.sub}</p>
      {group && <p className="system-cleanup-facts">{facts(group)}</p>}
      {group?.blocked && <p className="system-cleanup-facts">{text.blocked}</p>}
      <div className="system-cleanup-card-foot">
        <p className="system-cleanup-caveat">{text.caveat}</p>
        <button
          type="button"
          className="button secondary"
          aria-expanded={open}
          aria-controls={panel}
          aria-label={`${text.title}: ${copy.cleanup.open}`}
          onClick={() => setOpen(!open)}
        >
          {copy.cleanup.open}
        </button>
      </div>
      <div id={panel} hidden={!open} className="system-cleanup-panel">
        {open && <List />}
      </div>
    </article>
  );
}

/**
 * System status › Storage › Free up space: what each group can free, from the summary
 * measured in the background, and its list with the existing confirmations.
 */
export default function StorageCleanup({ summary }) {
  const measured = summaryGroups(summary);
  const total = measured
    ? groups.reduce((sum, item) => sum + (measured[item.summary]?.bytes || 0), 0)
    : null;
  return (
    <section className="system-cleanup" aria-labelledby="system-cleanup-heading">
      <div>
        <h3 id="system-cleanup-heading">{copy.cleanup.heading}</h3>
        <p className="system-cleanup-total" role="status">
          {measured ? copy.cleanup.upTo(statusBytes(total)) : unmeasured(summary)}
          {summary?.state === "refreshing" && <small>{copy.dataRefreshing}</small>}
        </p>
      </div>
      {groups.map((item) => (
        <CleanupCard
          key={item.id}
          id={item.id}
          List={item.List}
          group={measured?.[item.summary] || null}
          unknown={unmeasured(summary)}
          facts={item.facts}
        />
      ))}
      <p className="hint">{copy.cleanup.footnote}</p>
    </section>
  );
}
