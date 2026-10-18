import React from "react";
import { systemStatusCopy as copy } from "../../lib/i18n/messages/system-status.js";
import Icon from "../../components/Icon.jsx";
import { clampPercent, statusPercent } from "./system-status-format.js";

export function SystemMeter({ label, percent, value, tone = "" }) {
  return (
    // Spans only: the start page renders the meters inside its row button.
    <span className={`system-meter ${tone}`}>
      <span className="system-meter-top">
        <span>{label}</span>
        <strong>{statusPercent(percent)}</strong>
      </span>
      {/* The text below carries the value; the bar only repeats it visually. */}
      <span className="system-meter-bar" aria-hidden="true">
        <i style={{ width: `${clampPercent(percent)}%` }} />
      </span>
      <small>{value}</small>
    </span>
  );
}

export function DiskWarning({ status }) {
  if (!status?.warning?.diskLow) return null;
  return (
    <div className="system-status-warning" role="alert">
      <Icon name="info" size={16} />
      <p>
        <strong>{copy.diskLowTitle}</strong>
        {copy.diskLow(
          statusPercent(status.disk.freePercent, 1),
          statusPercent(status.warning.thresholdPercent),
        )}
      </p>
    </div>
  );
}
