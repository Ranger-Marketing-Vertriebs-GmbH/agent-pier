import React, { useId } from "react";
import Icon from "../../components/Icon.jsx";
import { InfoHintButton, InfoHintText, useInfoHint } from "../../components/InfoHint.jsx";
import { assistantAdvancedCopy as copy } from "../../lib/i18n/messages/assistant-advanced.js";

// IANA zones of this browser; the server checks the name again.
function timeZones() {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

/** Options of a select setting; "" is OpenClaw's default and comes first. */
export function settingOptions(setting, value) {
  const text = copy.settings[setting.id];
  const values = setting.format === "timeZone" ? timeZones() : setting.options || [];
  // A stored zone this browser does not list stays selectable.
  const listed = value && !values.includes(value) ? [value, ...values] : values;
  return [
    { value: "", label: copy.defaultOption(text.fallback) },
    ...listed.map((option) => ({
      value: option,
      label: text.options?.[option] ?? option,
    })),
  ];
}

function Control({ setting, value, onChange, disabled, ...aria }) {
  if (setting.type === "integer" || setting.type === "number")
    return (
      <input
        {...aria}
        type="number"
        inputMode="numeric"
        className="list-row-number"
        value={value}
        min={setting.minimum}
        max={setting.maximum}
        step={setting.type === "integer" ? 1 : "any"}
        placeholder={copy.reset}
        disabled={disabled}
        onChange={(event) =>
          onChange(event.target.value === "" ? "" : Number(event.target.value))
        }
      />
    );
  return (
    <span className="list-row-select">
      <select
        {...aria}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {settingOptions(setting, value).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Icon name="down" size={14} />
    </span>
  );
}

/**
 * One allowed setting: our label, its default and how it takes effect, the help as
 * a disclosure, a control by type and a reset to OpenClaw's default.
 */
export default function AdvancedSettingRow({ setting, value, onChange, disabled }) {
  const text = copy.settings[setting.id];
  const info = useInfoHint();
  const id = useId();
  const restart = setting.reloadKind === "restart";
  const locked = disabled || !setting.available;
  return (
    <>
      <div className="list-row two-line advanced-setting-row">
        <label className="list-row-main" htmlFor={id}>
          <span className="list-row-text">
            <span className="list-row-label" id={`${id}-label`}>
              {text.label}
              {text.unit && <span className="advanced-setting-unit"> ({text.unit})</span>}
            </span>
            <span className="list-row-sub" id={`${id}-sub`}>
              {setting.available ? copy.defaultValue(text.fallback) : copy.unavailable}
              {setting.available && (
                <span
                  className={`list-row-pill advanced-setting-badge${restart ? "" : " live"}`}
                  title={restart ? copy.restartLabel : copy.liveLabel}
                >
                  {restart ? copy.restart : copy.live}
                </span>
              )}
            </span>
          </span>
        </label>
        <InfoHintButton hint={info} label={text.label} />
        <Control
          id={id}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-sub`}
          setting={setting}
          value={value}
          onChange={onChange}
          disabled={locked}
        />
        {value !== "" && (
          <button
            type="button"
            className="advanced-setting-reset"
            aria-label={copy.resetLabel(text.label)}
            disabled={locked}
            onClick={() => onChange("")}
          >
            {copy.reset}
          </button>
        )}
      </div>
      <InfoHintText hint={info}>{text.help}</InfoHintText>
    </>
  );
}
