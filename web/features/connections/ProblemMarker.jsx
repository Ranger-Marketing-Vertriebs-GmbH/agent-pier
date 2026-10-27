import React from "react";
import StatusChip from "../../components/StatusChip.jsx";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";

/**
 * The warning mark of a Zugänge entry with a problem or warning: the entries the
 * highlighted number of the categories counts (problemRowIds). Its text names the
 * state for screen readers; the colour only repeats it.
 */
export default function ProblemMarker() {
  return (
    <span className="connections-problem">
      <StatusChip tone="warning">{copy.problemMarker}</StatusChip>
    </span>
  );
}
