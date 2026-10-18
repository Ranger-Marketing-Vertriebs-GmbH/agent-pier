import React, { useId, useState } from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import FieldError from "../FieldError.jsx";
import Switch from "../../../components/Switch.jsx";
import { isSecretName, isWriteSwitch } from "./setting-hints.js";

/**
 * One setting as a card: its name (typed, or fixed from a guide or the directory),
 * markers, description and value. Secret values are masked with a labelled toggle;
 * `choices` become a select and `format: "boolean"` a switch. Values never leave
 * React memory before the save.
 */
export default function SettingRow({ row, hint = {}, problem, onChange, onRemove }) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const name = row.name.trim();
  const secret = hint.secret === true || isSecretName(name);
  const errorId = `${id}-error`;
  const invalid = problem ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  const markers = [
    hint.required ? copy.settings.required : copy.settings.optional,
    secret && copy.settings.secret,
  ].filter(Boolean);
  const value = (event) => onChange({ value: event.target.value });
  return (
    <div className="mcp-setting">
      <div className="mcp-setting-head">
        {row.fixed ? (
          <code className="mcp-wizard-mono">{row.name}</code>
        ) : (
          <input
            aria-label={copy.settings.name}
            placeholder={copy.settings.name}
            value={row.name}
            maxLength={200}
            autoCapitalize="none"
            spellCheck={false}
            className="mcp-wizard-mono"
            onChange={(event) => onChange({ name: event.target.value })}
          />
        )}
        {markers.map((marker) => (
          <span key={marker} className="list-row-pill">
            {marker}
          </span>
        ))}
      </div>
      <p className="mcp-hint">{hint.description || copy.settings.noDescription}</p>
      {Array.isArray(hint.choices) && hint.choices.length ? (
        <select
          aria-label={copy.settings.value}
          value={row.value}
          {...invalid}
          onChange={value}
        >
          <option value="">{hint.default ? `${hint.default} ·` : "—"}</option>
          {hint.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : hint.format === "boolean" ? (
        <Switch
          label={copy.settings.value}
          checked={row.value === "true"}
          {...invalid}
          onChange={(checked) => onChange({ value: checked ? "true" : "false" })}
        />
      ) : (
        <div className="mcp-setting-value">
          <input
            aria-label={copy.settings.value}
            type={secret && !shown ? "password" : "text"}
            autoComplete={secret ? "new-password" : "off"}
            placeholder={hint.default ?? ""}
            value={row.value}
            maxLength={16384}
            autoCapitalize="none"
            spellCheck={false}
            {...invalid}
            onChange={value}
          />
          {secret && (
            <button
              type="button"
              className="button secondary mcp-wizard-icon"
              aria-pressed={shown}
              aria-label={shown ? copy.settings.hide(name) : copy.settings.show(name)}
              onClick={() => setShown(!shown)}
            >
              <span aria-hidden="true">{shown ? "◡" : "◉"}</span>
            </button>
          )}
        </div>
      )}
      <FieldError id={errorId} text={problem ? copy.settings.problems[problem] : ""} />
      {isWriteSwitch(name, hint.description) && (
        <p className="mcp-hint mcp-write-switch">{copy.settings.writeSwitch}</p>
      )}
      {!hint.required && (
        <button
          type="button"
          className="button text"
          aria-label={copy.settings.remove(name || copy.settings.name)}
          onClick={onRemove}
        >
          {copy.settings.removeShort}
        </button>
      )}
    </div>
  );
}
