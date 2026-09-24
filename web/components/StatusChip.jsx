import React from "react";
export default function StatusChip({ tone, children }) {
  if (tone === "decision") {
    return <span className="status-chip status-chip-decision">{children}</span>;
  }
  return (
    <span className={`status-chip status-chip-dot status-chip-${tone}`}>
      <span className="status-chip-mark" />
      {children}
    </span>
  );
}
