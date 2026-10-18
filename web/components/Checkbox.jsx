import React from "react";

// One choice among several, or an option of an action (docs/ui-guide.md#binary-settings):
// the box, then its label. A setting that is simply on or off is a Switch instead.
// Extra input props pass through; `onChange` receives the new boolean.
export default function Checkbox({ label, checked, onChange, className = "", ...input }) {
  return (
    <label className={["checkbox-field", className].filter(Boolean).join(" ")}>
      <input
        {...input}
        type="checkbox"
        className="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="checkbox-field-label">{label}</span>
    </label>
  );
}
