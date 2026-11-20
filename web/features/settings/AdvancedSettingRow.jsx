import React, { useId } from "react";
import Icon from "../../components/Icon.jsx";
import { InfoHintButton, InfoHintText, useInfoHint } from "../../components/InfoHint.jsx";
import { formatNumber } from "../../lib/i18n/index.js";
import { assistantAdvancedCopy as copy } from "../../lib/i18n/messages/assistant-advanced.js";

// IANA zones of this browser; the server checks the name again.
function timeZones() {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

/**
 * The value that applies while the setting is unset, in the field's own unit: a number
 * from the server (with our note, e.g. "48 hours"), an option label, or our words
 * where it depends on the host or the model.
 */
export function fallbackText(setting) {
  const text = copy.settings[setting.id];
  if (typeof setting.fallback === "number") {
    const amount = `${formatNumber(setting.fallback)} ${text.unit}`;
    return text.fallbackNote ? `${amount} (${text.fallbackNote})` : amount;
  }
  if (typeof setting.fallback === "string")
    return text.options?.[setting.fallback] ?? setting.fallback;
  return text.fallback;
}

/** Options of a select setting; "" is the default and comes first. */
export function settingOptions(setting, value) {
  const text = copy.settings[setting.id];
  const values = setting.format === "timeZone" ? timeZones() : setting.options || [];
  // A stored zone this browser does not list stays selectable.
  const listed = value && !values.includes(value) ? [value, ...values] : values;
  return [
    { value: "", label: copy.defaultOption(fallbackText(setting)) },
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

// A scope pill's words and its longer title (advanced-scopes.js settingScope).
const pillText = (pill) =>
  pill.kind === "only"
    ? [copy.runtimeOnly(pill.name), copy.runtimeOnlyLabel(pill.name, pill.other)]
    : [copy.runtimeRestart(pill.name), copy.runtimeRestartLabel(pill.name)];

/**
 * One shared setting: our label, its default and how it takes effect, the help as
 * a disclosure, a control by type and a reset to the default. `scope`
 * (advanced-scopes.js settingScope) says how the first runtime that takes it does
 * (`taken`: its badge, and whether it can be changed) and adds a pill per further
 * runtime with agents: "<name> only", or that its agents restart.
 */
export default function AdvancedSettingRow({
  setting,
  value,
  onChange,
  disabled,
  scope = { taken: null, pills: [] },
}) {
  const text = copy.settings[setting.id];
  const info = useInfoHint();
  const id = useId();
  const available = scope.taken?.available === true;
  const restart = scope.taken?.apply === "restart";
  const locked = disabled || !available;
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
              {available ? copy.defaultValue(fallbackText(setting)) : copy.unavailable}
              {available && (
                <span
                  className={`list-row-pill advanced-setting-badge${restart ? "" : " live"}`}
                  title={restart ? copy.restartLabel : copy.liveLabel}
                >
                  {restart
                    ? copy.restart
                    : scope.name
                      ? copy.liveFor(scope.name)
                      : copy.live}
                </span>
              )}
              {scope.pills.map((pill) => {
                const [words, title] = pillText(pill);
                return (
                  <span
                    key={`${pill.kind}:${pill.name}`}
                    className="list-row-pill advanced-setting-badge scope"
                    title={title}
                  >
                    {words}
                  </span>
                );
              })}
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
