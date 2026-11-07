import React from "react";

// One status dot for every state (docs/ui-guide.md#status-colours): working,
// waiting, ok, error, idle, warning, pending (a dimmed idle) and unknown (hollow).
// `pulse` animates a working dot. Decorative by default; pass `label` when the dot
// is the only sign of the state, and `title` to show it on hover. `className`
// positions it inside its feature.
export default function StatusDot({
  tone = "idle",
  pulse = false,
  label,
  title,
  className = "",
}) {
  return (
    <span
      className={["status-dot", `status-dot-${tone}`, pulse ? "pulse" : "", className]
        .filter(Boolean)
        .join(" ")}
      role={label ? "img" : undefined}
      aria-label={label}
      title={title}
      aria-hidden={label ? undefined : "true"}
    />
  );
}
