import React from "react";

// Rows sit on a darker card; the 1px gap between them draws the dividers.
export default function ListCard({
  label,
  labelledBy,
  disabled = false,
  className = "",
  children,
}) {
  return (
    <div
      role="group"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      className={["list-card", disabled ? "is-disabled" : "", className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}
