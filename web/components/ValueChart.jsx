import React, { useId } from "react";
import { chartScale } from "./value-chart.js";
import "./value-chart.css";

/**
 * A small chart of labelled values: `kind` "line" (default) or "bar", `points`
 * `[{ label, value }]` in order, `label` names it for screen readers, `unit` follows
 * each value, `formatValue` formats one (default: the number as it is). The y axis
 * starts at 0 unless a value is negative; the first and last labels mark the x axis.
 * Screen readers get a table of all values. For percentages over time use
 * HistoryChart.
 */
export default function ValueChart({
  kind = "line",
  points,
  label,
  unit = "",
  formatValue = (value) => String(value),
  className = "",
}) {
  const id = useId();
  const { min, max, x, y, step } = chartScale(points, { bar: kind === "bar" });
  const text = (value) => `${formatValue(value)}${unit ? ` ${unit}` : ""}`;
  const line = points
    .map((point, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(point.value).toFixed(2)}`)
    .join("");
  return (
    <figure className={["value-chart", className].filter(Boolean).join(" ")}>
      <div className="value-chart-body" aria-hidden="true">
        <div className="value-chart-y">
          <span>{text(max)}</span>
          <span>{text(min)}</span>
        </div>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="value-chart-plot"
        >
          <line className="value-chart-grid" x1="0" x2="100" y1="0" y2="0" />
          <line className="value-chart-grid" x1="0" x2="100" y1="50" y2="50" />
          <line className="value-chart-axis" x1="0" x2="100" y1={y(0)} y2={y(0)} />
          {kind === "bar"
            ? points.map((point, i) => (
                <rect
                  key={i}
                  className="value-chart-bar"
                  x={(x(i) - step * 0.35).toFixed(2)}
                  width={(step * 0.7).toFixed(2)}
                  y={Math.min(y(point.value), y(0)).toFixed(2)}
                  height={Math.abs(y(point.value) - y(0)).toFixed(2)}
                />
              ))
            : [
                <path key="line" className="value-chart-line" d={line} />,
                points.length === 1 && (
                  <circle
                    key="dot"
                    className="value-chart-dot"
                    cx={x(0)}
                    cy={y(points[0].value)}
                    r="1.5"
                  />
                ),
              ]}
        </svg>
        <div className="value-chart-x">
          <span>{points[0]?.label}</span>
          {points.length > 1 && <span>{points.at(-1).label}</span>}
        </div>
      </div>
      <table className="visually-hidden" aria-labelledby={`${id}-caption`}>
        <caption id={`${id}-caption`}>{label}</caption>
        <tbody>
          {points.map((point, i) => (
            <tr key={i}>
              <th scope="row">{point.label}</th>
              <td>{text(point.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
