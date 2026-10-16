import React from "react";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy } from "../../lib/i18n/messages/mcp-wizard.js";
import FieldError from "./FieldError.jsx";

/** The server name: the tools' prefix in every CLI and agent; a rename is explained. */
export default function NameField({
  id,
  value,
  onChange,
  error,
  errorId,
  renamed = false,
  // The step checks the name itself and shows a catalog message, not the browser's.
  selfChecked = false,
}) {
  const describedBy = [`${id}-rule`, error ? errorId : "", renamed ? `${id}-rename` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="mcp-field">
      <label htmlFor={id}>{copy.nameLabel}</label>
      <input
        id={id}
        value={value}
        required={!selfChecked}
        maxLength={30}
        pattern={selfChecked ? undefined : "[A-Za-z][A-Za-z0-9_\\-]{0,29}"}
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError id={errorId} text={error} />
      <small className="mcp-hint" id={`${id}-rule`}>
        {copy.nameRule}
      </small>
      {renamed && (
        <small className="mcp-hint" id={`${id}-rename`}>
          {mcpWizardCopy.edit.renameNote}
        </small>
      )}
    </div>
  );
}
