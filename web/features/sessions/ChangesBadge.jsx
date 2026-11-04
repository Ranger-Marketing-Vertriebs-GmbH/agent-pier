import React from "react";

// The Changes tab's count of changed files; the tab's accessible name carries it.
export default function ChangesBadge({ count }) {
  if (!count) return null;
  return (
    <span className="badge session-changes-badge" aria-hidden="true">
      {count}
    </span>
  );
}
