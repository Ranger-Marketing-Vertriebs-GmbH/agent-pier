import React from "react";
import StatusDot from "./StatusDot.jsx";
import "./filter-chips.css";

/**
 * Toggle chips with a count for three to six filters of one list, such as the
 * session states on the start page. One chip is pressed at a time; `options` are
 * `{ value, label, count, dot }` (`dot` a StatusDot tone). A row that does not fit
 * scrolls sideways. `Segment` covers two to four values without counts.
 */
export default function FilterChips({ label, options, value, onChange, className = "" }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={["filter-chips", className].filter(Boolean).join(" ")}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="filter-chip"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.dot && <StatusDot tone={option.dot} />}
          <span>{option.label}</span>
          {Number.isFinite(option.count) && (
            <span className="filter-chip-count">{option.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
