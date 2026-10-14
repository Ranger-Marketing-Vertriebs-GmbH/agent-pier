import React, { useId } from "react";

// A checkbox row whose whole surface toggles it: title, optional subtitle and extra
// lines (`children`), with a themed check mark and a touch-sized target. The title
// names the checkbox; subtitle and extra lines describe it.
export default function CheckRow({
  title,
  subtitle,
  children,
  className = "",
  ...input
}) {
  const id = useId();
  const described = Boolean(subtitle || children);
  return (
    <label className={["check-row", className].filter(Boolean).join(" ")}>
      <input
        type="checkbox"
        aria-labelledby={`${id}-title`}
        aria-describedby={described ? `${id}-details` : undefined}
        {...input}
      />
      <span className="check-row-text">
        <span id={`${id}-title`} className="check-row-title">
          {title}
        </span>
        {described && (
          <span id={`${id}-details`} className="check-row-details">
            {subtitle && <span className="check-row-subtitle">{subtitle}</span>}
            {children}
          </span>
        )}
      </span>
    </label>
  );
}
