import React, { useId, useState } from "react";
import { GAP_MS, lineSegments, nearestIndex, timeGaps } from "./history-chart.js";

const TICKS = [100, 75, 50, 25, 0];
const clamp = (value) => Math.min(100, Math.max(0, value));
const TONES = new Set(["cpu", "memory", "agentpier", "other"]);
const toneClass = (item) =>
  `chart-tone-${TONES.has(item.tone) ? item.tone : "other"}${item.dashed ? " dashed" : ""}`;

/**
 * A line chart of percentages (0–100) over a time window, for a few series.
 * `series` is `[{ id, label, field, tone, dashed }]` with tone `cpu`, `memory`,
 * `agentpier` or `other`; `points` are `{ t, [field]: value }`. Gaps longer than 90 s
 * are hatched and break the lines. Legend buttons toggle a series; a crosshair with a
 * tooltip follows the pointer, and the arrow keys move it while the chart has focus.
 * Screen readers get `label` and a table of the last values.
 */
export default function HistoryChart({
  label,
  heading,
  toolbar,
  series,
  points,
  start,
  end,
  xLabels = [],
  formatValue,
  formatTime,
  timeLabel,
  footer,
  className = "",
}) {
  const id = useId();
  const [hidden, setHidden] = useState(() => new Set());
  const [active, setActive] = useState(null);
  const [keyboard, setKeyboard] = useState(false);
  const span = Math.max(1, end - start);
  const shown = points.filter((point) => point.t >= start && point.t <= end);
  const visible = series.filter((item) => !hidden.has(item.id));
  const x = (t) => ((t - start) / span) * 100;
  const y = (value) => 100 - clamp(value);
  const index = active === null ? -1 : Math.min(active, shown.length - 1);
  const current = index >= 0 ? shown[index] : null;
  // A single point is drawn as a zero-length line with round caps: a dot.
  const linePath = (segment, field) => {
    const steps = segment.map(
      (entry) => `${x(entry.t).toFixed(2)},${y(entry[field]).toFixed(2)}`,
    );
    if (steps.length === 1) steps.push(steps[0]);
    return `M${steps.join("L")}`;
  };
  const toggle = (seriesId) =>
    setHidden((before) => {
      const next = new Set(before);
      if (!next.delete(seriesId)) next.add(seriesId);
      return next;
    });
  const point = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !shown.length) return;
    const at = start + ((event.clientX - box.left) / box.width) * span;
    setKeyboard(false);
    setActive(nearestIndex(shown, at));
  };
  const key = (event) => {
    if (!shown.length) return;
    const last = shown.length - 1;
    const from = index < 0 ? last : index;
    const moves = {
      ArrowLeft: Math.max(0, from - 1),
      ArrowRight: Math.min(last, from + 1),
      Home: 0,
      End: last,
    };
    if (event.key === "Escape" && index >= 0) {
      event.preventDefault();
      event.stopPropagation();
      setActive(null);
      return;
    }
    if (!(event.key in moves)) return;
    event.preventDefault();
    setKeyboard(true);
    setActive(index < 0 ? last : moves[event.key]);
  };
  const tooltipText =
    current &&
    [
      formatTime(current.t),
      ...visible.map((item) => `${item.label} ${formatValue(current[item.field])}`),
    ].join(", ");
  return (
    <figure className={["history-chart", className].filter(Boolean).join(" ")}>
      <div className="history-chart-head">
        {heading}
        <div className="history-chart-legend">
          {series.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`history-chart-toggle ${toneClass(item)}`}
              aria-pressed={!hidden.has(item.id)}
              onClick={() => toggle(item.id)}
            >
              <i aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </div>
        {toolbar}
      </div>
      <div className="history-chart-body">
        <div className="history-chart-y" aria-hidden="true">
          {TICKS.map((tick) => (
            <span key={tick} style={{ top: `${100 - tick}%` }}>
              {formatValue(tick)}
            </span>
          ))}
        </div>
        <div
          className="history-chart-plot"
          onPointerMove={point}
          onPointerDown={point}
          onPointerLeave={() => !keyboard && setActive(null)}
        >
          {timeGaps(shown, GAP_MS).map((gap) => (
            <span
              key={gap.from}
              className="history-chart-gap"
              style={{ left: `${x(gap.from)}%`, width: `${x(gap.to) - x(gap.from)}%` }}
            />
          ))}
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            role="img"
            aria-label={label}
            tabIndex={0}
            onKeyDown={key}
            onBlur={() => {
              setKeyboard(false);
              setActive(null);
            }}
          >
            {TICKS.map((tick) => (
              <line
                key={tick}
                className="history-chart-grid"
                x1="0"
                x2="100"
                y1={y(tick)}
                y2={y(tick)}
              />
            ))}
            {visible.map((item) =>
              lineSegments(shown, item.field, GAP_MS).map((segment) => (
                <path
                  key={`${item.id}-${segment[0].t}`}
                  className={`history-chart-line ${toneClass(item)}`}
                  d={linePath(segment, item.field)}
                />
              )),
            )}
          </svg>
          {current && (
            <>
              <span
                className="history-chart-crosshair"
                style={{ left: `${x(current.t)}%` }}
              />
              <div
                className={`history-chart-tooltip${x(current.t) > 60 ? " flip" : ""}`}
                style={{ left: `${x(current.t)}%` }}
                aria-hidden="true"
              >
                <strong>{formatTime(current.t)}</strong>
                {visible.map((item) => (
                  <span key={item.id} className={toneClass(item)}>
                    {item.label}
                    <b>{formatValue(current[item.field])}</b>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="history-chart-x" aria-hidden="true">
          {xLabels.map((tick) => (
            <span key={tick.at} style={{ left: `${x(tick.at)}%` }}>
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <p className="visually-hidden" aria-live="polite">
        {keyboard && tooltipText}
      </p>
      <table className="visually-hidden" aria-labelledby={`${id}-caption`}>
        <caption id={`${id}-caption`}>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{timeLabel}</th>
            {series.map((item) => (
              <th key={item.id} scope="col">
                {item.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.slice(-5).map((entry) => (
            <tr key={entry.t}>
              <th scope="row">{formatTime(entry.t)}</th>
              {series.map((item) => (
                <td key={item.id}>{formatValue(entry[item.field])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {footer}
    </figure>
  );
}
