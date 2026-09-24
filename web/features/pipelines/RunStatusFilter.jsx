import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { statusFilters } from "./run-presentation.js";
import "./run-table.css";

export default function RunStatusFilter({ counts, selected, onSelect }) {
  const all = counts
    ? Object.values(counts).reduce((sum, value) => sum + value, 0)
    : null;
  return (
    <div className="run-status-filters" role="group" aria-label={copy.status}>
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
            {status && <span className="run-status-dot" />}
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
