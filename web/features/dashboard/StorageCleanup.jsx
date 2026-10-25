import React, { useId, useState } from "react";
import { systemStatusCopy as copy } from "../../lib/i18n/messages/system-status.js";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import CleanupSnapshots from "./CleanupSnapshots.jsx";
import CleanupTranscripts from "./CleanupTranscripts.jsx";
import CleanupDependencies from "./CleanupDependencies.jsx";

const groups = [
  ["snapshots", CleanupSnapshots],
  ["transcripts", CleanupTranscripts],
  ["dependencies", CleanupDependencies],
];

function CleanupGroup({ id, List }) {
  const [open, setOpen] = useState(false);
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

/** System status › Data directory: what can be deleted to free space, on request. */
export default function StorageCleanup() {
  return (
    <section className="system-cleanup" aria-labelledby="system-cleanup-heading">
      <h4 id="system-cleanup-heading">{copy.cleanup.heading}</h4>
      {groups.map(([id, List]) => (
        <CleanupGroup key={id} id={id} List={List} />
      ))}
    </section>
  );
}
