import React from "react";
import "./drop-zone.css";

// The highlight of the drop zone under a drag: half of the parent for an edge, all of
// it for the centre. The parent must be positioned. `title` says why a zone is limited.
export default function DropZoneOverlay({ side, label, title }) {
  if (!side) return null;
  return (
    <div className="drop-zone-overlay" data-side={side} title={title} aria-hidden="true">
      {label ? <span className="drop-zone-label">{label}</span> : null}
    </div>
  );
}
