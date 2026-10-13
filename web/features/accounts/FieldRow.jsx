import React from "react";

// A labelled input inside a list card; the help line sits outside the label so the
// input's accessible name stays the label text alone.
export default function FieldRow({ label, help, className = "", children }) {
  return (
    <div className={["field-row", className].filter(Boolean).join(" ")}>
      <label>
        <span className="field-row-label">{label}</span>
        {children}
      </label>
      {help && <p className="field-row-help">{help}</p>}
    </div>
  );
}
