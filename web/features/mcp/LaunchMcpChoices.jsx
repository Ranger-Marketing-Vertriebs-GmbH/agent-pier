import React from "react";
import { mcpCopy as copy } from "../../lib/i18n/messages/mcp.js";
export default function LaunchMcpChoices({ selection, change }) {
  return (
    <label className="agentbus-launch">
      <input
        type="checkbox"
        checked={Boolean(selection)}
        onChange={(event) => change(event.target.checked)}
      />
      <span>
        <strong>{copy.sessionTools}</strong>
        <small>{copy.sessionToolsSummary}</small>
      </span>
    </label>
  );
}
