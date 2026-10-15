import React, { useId, useState } from "react";
import { mcpPackageCopy as copy } from "../../lib/i18n/messages/mcp-packages.js";

/**
 * The programs a build installed when it named several (status `choosing`); choosing
 * one activates it without a rebuild (owner decision 1).
 */
export default function McpPackageProgramChoice({ programs, busy, onChoose }) {
  const id = useId();
  const [picked, setPicked] = useState("");
  // A new list (a failed choice reads it again) falls back to its first program.
  const program = programs.includes(picked) ? picked : programs[0] || "";
  return (
    <div className="mcp-package-update">
      <p className="mcp-hint" id={`${id}-hint`}>
        {copy.choosingHint}
      </p>
      <div className="mcp-field">
        <label htmlFor={id}>{copy.programLabel}</label>
        <select
          id={id}
          value={program}
          aria-describedby={`${id}-hint`}
          onChange={(event) => setPicked(event.target.value)}
        >
          {programs.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="mcp-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy || !program}
          onClick={() => onChoose(program)}
        >
          {copy.chooseProgram}
        </button>
      </div>
    </div>
  );
}
