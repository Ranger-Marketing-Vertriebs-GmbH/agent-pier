import React from "react";

// A checkbox row whose whole surface toggles it: title, optional subtitle and extra
// lines (`children`), with a themed check mark and a touch-sized target.
export default function CheckRow({
  title,
  subtitle,
  children,
  className = "",
  ...input
}) {
  return (
    <label className={["check-row", className].filter(Boolean).join(" ")}>
      <input type="checkbox" {...input} />
      <span className="check-row-text">
        <span className="check-row-title">{title}</span>
        {subtitle && <span className="check-row-subtitle">{subtitle}</span>}
        {children}
      </span>
    </label>
  );
}
