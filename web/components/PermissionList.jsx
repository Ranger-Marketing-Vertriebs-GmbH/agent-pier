import React from "react";
import Icon from "./Icon.jsx";

// Granted capabilities, each with a check mark. `items` are `[key, label]` pairs; name
// the list with `label`, or with `labelledBy` when a visible heading already says it.
export default function PermissionList({ items, label, labelledBy }) {
  return (
    <ul
      className="permission-list"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
    >
      {items.map(([key, text]) => (
        <li key={key}>
          <Icon name="check" size={16} />
          {text}
        </li>
      ))}
    </ul>
  );
}
