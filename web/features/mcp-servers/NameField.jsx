import React, { useState } from "react";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import { mcpWizardCopy } from "../../lib/i18n/messages/mcp-wizard.js";
import FieldError from "./FieldError.jsx";

/**
 * The name the server stores: a letter, then up to 29 letters, digits, "-" or "_"
 * (mcp-server store); `pattern` below repeats it for the browser's check.
 */
export const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,29}$/;

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
  // The browser's refusal, shown in place instead of its bubble; typing clears it.
  const [refused, setRefused] = useState("");
  const shown = error || refused;
  const describedBy = [`${id}-rule`, shown ? errorId : "", renamed ? `${id}-rename` : ""]
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
        aria-invalid={shown ? true : undefined}
        aria-describedby={describedBy}
        onInvalid={(event) => {
          event.preventDefault();
          setRefused(mcpWizardCopy.paste.errors.nameInvalid);
          event.currentTarget.focus();
        }}
        onChange={(event) => {
          if (refused && NAME_PATTERN.test(event.target.value)) setRefused("");
          onChange(event.target.value);
        }}
      />
      <FieldError id={errorId} text={shown} />
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
