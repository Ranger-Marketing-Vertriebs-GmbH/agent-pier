import React from "react";

// A binary setting (docs/ui-guide.md#binary-settings): the label, then the switch.
// The whole label is the touch target. Extra input props (aria-describedby, name)
// pass through; `onChange` receives the new boolean.
export default function Switch({ label, checked, onChange, className = "", ...input }) {
  return (
    <label className={["switch-field", className].filter(Boolean).join(" ")}>
      <span className="switch-field-label">{label}</span>
      <input
        {...input}
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
