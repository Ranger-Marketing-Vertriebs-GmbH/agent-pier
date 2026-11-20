import React from "react";
import "./drop-zone.css";

// The highlight of the drop zone under a drag: half of the parent for an edge, all of
// it for the centre. The parent must be positioned. `refused` instead tells, over the
// whole parent, why the drag cannot drop there.
export default function DropZoneOverlay({ side, label, refused }) {
  if (!side && refused)
    return (
      <div className="drop-zone-overlay is-refused" role="status">
        <span className="drop-zone-label">{refused}</span>
      </div>
    );
  if (!side) return null;
  return (
    <div className="drop-zone-overlay" data-side={side} aria-hidden="true">
      {label ? <span className="drop-zone-label">{label}</span> : null}
    </div>
  );
}
