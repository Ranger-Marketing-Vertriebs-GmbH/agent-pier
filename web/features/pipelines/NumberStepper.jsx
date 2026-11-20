import React, { useId, useState } from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";

// A bounded number with − and + buttons, such as loop rounds or a group's concurrency.
export default function NumberStepper({
  label,
  decreaseLabel,
  increaseLabel,
  min,
  max,
  value,
  onChange,
  disabled,
}) {
  const id = useId();
  const clamp = (number) => Math.min(max, Math.max(min, number));
  const current = Number.isFinite(value) ? clamp(value) : min;
  // An emptied field stays empty while typing and returns to the last value on blur.
  const [typing, setTyping] = useState(null);
  // A typed number outside the bounds turns into the nearest bound and the range shows
  // below, so that the change (and a Save that stays off) is not silent.
  const [clamped, setClamped] = useState(false);
  const step = (number) => {
    setClamped(false);
    onChange(clamp(number));
  };
  return (
    <div className="stage-field">
      <label htmlFor={id}>{label}</label>
      <div className="stage-stepper">
        <button
          type="button"
          aria-label={decreaseLabel}
          disabled={disabled || current <= min}
          onClick={() => step(current - 1)}
        >
          −
        </button>
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          aria-describedby={clamped ? `${id}-range` : undefined}
          value={typing ?? (Number.isFinite(value) ? value : min)}
          onChange={(event) => {
            const text = event.target.value;
            const number = Number(text);
            if (text === "" || !Number.isFinite(number)) return setTyping(text);
            setTyping(null);
            setClamped(number < min || number > max);
            onChange(clamp(Math.round(number)));
          }}
          onBlur={() => setTyping(null)}
        />
        <button
          type="button"
          aria-label={increaseLabel}
          disabled={disabled || current >= max}
          onClick={() => step(current + 1)}
        >
          +
        </button>
      </div>
      {clamped && (
        <small id={`${id}-range`} className="field-description" role="status">
          {copy.stepperRange(min, max)}
        </small>
      )}
    </div>
  );
}
