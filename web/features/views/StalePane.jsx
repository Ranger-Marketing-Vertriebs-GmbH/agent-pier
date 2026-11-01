import React from "react";
import { viewsCopy } from "../../lib/i18n/messages/views.js";

/** A pane whose session or chat is gone: what happened, and a way to take it out. */
export default function StalePane({ reason, onRemove }) {
  return (
    <div className="split-pane-stale" role="status">
      <p>{viewsCopy[reason]}</p>
      <button type="button" className="button secondary" onClick={onRemove}>
        {viewsCopy.removeStale}
      </button>
    </div>
  );
}
