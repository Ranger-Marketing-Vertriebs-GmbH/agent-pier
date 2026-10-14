import React from "react";
// `pill` frames the chip as a badge, e.g. the state at the top of a dialog.
export default function StatusChip({ tone, pill = false, children }) {
  if (tone === "decision") {
    return <span className="status-chip status-chip-decision">{children}</span>;
  }
  return (
    <span
      className={`status-chip status-chip-dot status-chip-${tone}${pill ? " status-chip-pill" : ""}`}
    >
      <span className="status-chip-mark" />
      {children}
    </span>
  );
}
