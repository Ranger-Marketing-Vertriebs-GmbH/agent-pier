import React, { useEffect, useState } from "react";
import { InfoHintButton, InfoHintText, useInfoHint } from "../../components/InfoHint.jsx";
import { accountsHubCopy } from "../../lib/i18n/messages/accounts.js";

// A stored key shows as a status line with "Replace"; the input appears on demand.
// A new `resetKey` (the draft restarted after Save, Cancel or Reload) returns to the
// status line.
export default function KeyField({
  label,
  saved,
  savedText,
  value,
  onChange,
  disabled = false,
  placeholder,
  hint,
  resetKey,
}) {
  const [replacing, setReplacing] = useState(false);
  useEffect(() => setReplacing(false), [resetKey]);
  const info = useInfoHint();
  const editing = !saved || replacing || value !== "";
  return (
    <div className="field-row key-field">
      <div className="key-field-line">
        {editing ? (
          <label>
            <span className="field-row-label">{label}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={value}
              disabled={disabled}
              placeholder={placeholder}
              autoFocus={replacing}
              onChange={(event) => onChange(event.target.value)}
            />
          </label>
        ) : (
          <div className="key-field-status">
            <span className="field-row-label">{label}</span>
            <span className="key-field-saved">{savedText}</span>
            <button
              type="button"
              className="button secondary compact"
              disabled={disabled}
              onClick={() => setReplacing(true)}
            >
              {accountsHubCopy.replaceKey}
            </button>
          </div>
        )}
        {hint && <InfoHintButton hint={info} />}
      </div>
      {hint && <InfoHintText hint={info}>{hint}</InfoHintText>}
    </div>
  );
}
