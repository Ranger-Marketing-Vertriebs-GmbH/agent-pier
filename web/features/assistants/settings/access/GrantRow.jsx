import React from "react";
import Icon from "../../../../components/Icon.jsx";
import { assistantSettingsCopy } from "../../../../lib/i18n/messages/assistant-settings.js";

const copy = assistantSettingsCopy.access;

/**
 * A granted entry in an Access group: name and monospace sub line, an optional mode
 * select (the same control as `SelectRow`), extra actions and "Entziehen". Every
 * change goes into the tab draft.
 */
export default function GrantRow({
  id,
  name,
  sub,
  pill,
  mode,
  actions,
  onRevoke,
  disabled = false,
}) {
  return (
    <div
      className={`list-row agent-access-row${sub ? " two-line" : ""}`}
      data-access-grant={id}
    >
      <div className="list-row-main">
        <span className="list-row-text">
          <span className="list-row-label">
            {name}
            {pill && <span className="list-row-pill">{pill}</span>}
          </span>
          {sub && <span className="list-row-sub agent-access-sub">{sub}</span>}
        </span>
      </div>
      {mode && (
        <span className="list-row-select">
          <select
            aria-label={mode.label}
            value={mode.value}
            disabled={disabled}
            onChange={(event) => mode.onChange(event.target.value)}
          >
            {mode.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Icon name="down" size={14} />
        </span>
      )}
      {actions}
      {onRevoke && (
        <button
          type="button"
          className="button secondary compact"
          aria-label={copy.revokeLabel(name)}
          disabled={disabled}
          onClick={onRevoke}
        >
          {copy.revoke}
        </button>
      )}
    </div>
  );
}
