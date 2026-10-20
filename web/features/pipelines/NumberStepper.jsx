import React, { useId, useState } from "react";

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
  return (
    <div className="stage-field">
      <label htmlFor={id}>{label}</label>
      <div className="stage-stepper">
        <button
          type="button"
          aria-label={decreaseLabel}
          disabled={disabled || current <= min}
          onClick={() => onChange(clamp(current - 1))}
        >
          −
        </button>
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          value={typing ?? (Number.isFinite(value) ? value : min)}
          onChange={(event) => {
            const text = event.target.value;
            const number = Number(text);
            if (text === "" || !Number.isFinite(number)) return setTyping(text);
            setTyping(null);
            onChange(clamp(Math.round(number)));
          }}
          onBlur={() => setTyping(null)}
        />
        <button
          type="button"
          aria-label={increaseLabel}
          disabled={disabled || current >= max}
          onClick={() => onChange(clamp(current + 1))}
        >
          +
        </button>
      </div>
    </div>
  );
}
