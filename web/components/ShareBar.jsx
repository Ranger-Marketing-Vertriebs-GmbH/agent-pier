import React from "react";

const TONES = new Set(["cpu", "memory", "other", "free"]);

/**
 * A stacked horizontal bar of shares of one whole, with an optional legend.
 * `segments` are `[{ id, label, value, tone, text }]` with tone `cpu`, `memory`,
 * `other` or `free`; a `free` segment is the empty track and appears only in the
 * legend. `text` (such as "48.6 GB") follows the legend label. The bar is an image
 * named by `label`; the legend repeats every share as text.
 */
export default function ShareBar({ label, segments, total, legend = true }) {
  const whole = Math.max(
    1,
    total ?? 0,
    segments.reduce((sum, item) => sum + Math.max(0, item.value || 0), 0),
  );
  const tone = (item) => (TONES.has(item.tone) ? item.tone : "other");
  return (
    <div className="share-bar">
      <div className="share-bar-track" role="img" aria-label={label}>
        {segments
          .filter((item) => tone(item) !== "free" && item.value > 0)
          .map((item) => (
            <i
              key={item.id}
              className={`chart-tone-${tone(item)}`}
              style={{ width: `${(item.value / whole) * 100}%` }}
            />
          ))}
      </div>
      {legend && (
        <ul className="share-bar-legend">
          {segments.map((item) => (
            <li key={item.id} className={`chart-tone-${tone(item)}`}>
              <i aria-hidden="true" />
              {item.label}
              {item.text && <span>{item.text}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
