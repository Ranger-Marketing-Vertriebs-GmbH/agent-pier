import React from "react";
import StatusDot from "./StatusDot.jsx";
import { chipTone } from "./status-tones.js";
// `pill` frames the chip as a badge, e.g. the state at the top of a dialog.
export default function StatusChip({ tone, pill = false, children }) {
  if (tone === "decision") {
    return <span className="status-chip status-chip-decision">{children}</span>;
  }
  return (
    <span
      className={`status-chip status-chip-dot status-chip-${tone}${pill ? " status-chip-pill" : ""}`}
    >
      <StatusDot tone={chipTone(tone)} className="status-chip-mark" />
      {children}
    </span>
  );
}
