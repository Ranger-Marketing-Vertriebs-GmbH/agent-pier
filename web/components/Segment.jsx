import React, { useId } from "react";
// A segmented choice built from native radios, so arrow keys, forms and
// assistive technology treat it like any other single-choice group.
export default function Segment({
  label,
  options,
  value,
  onChange,
  disabled = false,
  className = "",
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={["segment", className].filter(Boolean).join(" ")}
    >
      {options.map((option) => (
        <label key={option.value} className={option.value === value ? "selected" : ""}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}
