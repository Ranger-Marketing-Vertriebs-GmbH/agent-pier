import React, { useId, useState } from "react";
import Icon from "./Icon.jsx";
import StatusChip from "./StatusChip.jsx";
import "./activity-row.css";

/**
 * One step an agent took (a tool call such as an SSH or shell command) as a compact
 * row that opens to its details: icon, `label`, a one-line `detail` cut with an
 * ellipsis, and a `status` chip in `tone` (StatusChip's tones). `children` is the
 * expanded body, rendered only while open unless `keepMounted`. The row is a
 * disclosure button with `aria-expanded`.
 */
export default function ActivityRow({
  icon = "terminal",
  label,
  detail,
  status,
  tone = "neutral",
  defaultOpen = false,
  keepMounted = false,
  className,
  children,
  ...attributes
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = `${useId()}-activity`;
  return (
    <div
      className={className ? `activity-row ${className}` : "activity-row"}
      data-open={open || undefined}
      {...attributes}
    >
      <button
        type="button"
        className="activity-row-head"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="chevron" size={14} className="activity-row-chevron" />
        <Icon name={icon} size={16} className="activity-row-icon" />
        <span className="activity-row-label">{label}</span>
        {detail != null && <code className="activity-row-detail">{detail}</code>}
        {status && (
          <span className="activity-row-status">
            <StatusChip tone={tone}>{status}</StatusChip>
          </span>
        )}
      </button>
      <div id={id} className="activity-row-body" hidden={!open}>
        {(open || keepMounted) && children}
      </div>
    </div>
  );
}
