import React from "react";
import { commonCopy } from "../../lib/i18n/messages/common.js";

// A count that failed to load is left out of its label; this hint says so and
// offers another read without blocking the rest of the tab.
export default function CountUnavailable({ message, onRetry }) {
  return (
    <p className="project-count-error" role="status">
      <span>{message}</span>
      <button type="button" className="button secondary compact" onClick={onRetry}>
        {commonCopy.retry}
      </button>
    </p>
  );
}
