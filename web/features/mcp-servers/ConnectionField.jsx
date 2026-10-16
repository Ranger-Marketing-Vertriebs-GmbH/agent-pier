import React from "react";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";

/** A saved server's connection, read-only: it cannot change after saving. */
export default function ConnectionField({ transport }) {
  return (
    <div className="mcp-field">
      <span>{copy.transportLabel}</span>
      <p className="mcp-hint">
        {copy.transports[transport]} · {copy.transportLocked}
      </p>
    </div>
  );
}
