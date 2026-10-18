import React from "react";
import { systemStatusCopy as copy } from "../../lib/i18n/messages/system-status.js";
import Icon from "../../components/Icon.jsx";
import { clampPercent, statusPercent } from "./system-status-format.js";

export function SystemMeter({ label, percent, value, tone = "" }) {
  return (
    <div className={`system-meter ${tone}`}>
      <div className="system-meter-top">
        <span>{label}</span>
        <strong>{statusPercent(percent)}</strong>
      </div>
      {/* The text below carries the value; the bar only repeats it visually. */}
      <div className="system-meter-bar" aria-hidden="true">
        <i style={{ width: `${clampPercent(percent)}%` }} />
      </div>
      <small>{value}</small>
    </div>
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
