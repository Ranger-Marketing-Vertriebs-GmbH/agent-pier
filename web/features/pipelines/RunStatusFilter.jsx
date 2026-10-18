import React, { useRef } from "react";
import { edgeClassNames } from "../../components/scroll-fade.js";
import useScrollFade from "../../components/useScrollFade.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { statusFilters } from "./run-presentation.js";
import StatusDot from "../../components/StatusDot.jsx";
import "./run-table.css";

const runStatusTones = {
  running: "working",
  "awaiting-human": "waiting",
  completed: "ok",
  failed: "error",
  cancelled: "idle",
};

export default function RunStatusFilter({ counts, selected, onSelect }) {
  const row = useRef(null);
  const { edges } = useScrollFade(row, {
    activeSelector: '[aria-pressed="true"]',
    revealKey: selected,
  });
  const all = counts
    ? Object.values(counts).reduce((sum, value) => sum + value, 0)
    : null;
  return (
    <div
      ref={row}
      className={edgeClassNames(edges, "run-status-filters", "scroll-fade")}
      role="group"
      aria-label={copy.status}
    >
      {statusFilters(counts, selected).map((status) => {
        const count = status ? counts?.[status] : all;
        return (
          <button
            key={status || "all"}
            type="button"
            className={status ? `run-status-${status}` : ""}
            aria-pressed={selected === status}
            onClick={() => onSelect(status)}
          >
            {status && <StatusDot tone={runStatusTones[status] ?? "idle"} />}
            {status ? copy.statuses[status] : copy.allStatuses}
            {count !== null && count !== undefined && (
              <span className="run-status-count">{` ${count}`}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
