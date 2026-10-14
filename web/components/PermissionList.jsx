import React from "react";
import Icon from "./Icon.jsx";

// Granted capabilities, each with a check mark. `items` are `[key, label]` pairs.
export default function PermissionList({ items, label }) {
  return (
    <ul className="permission-list" aria-label={label}>
      {items.map(([key, text]) => (
        <li key={key}>
          <Icon name="check" size={16} />
          {text}
        </li>
      ))}
    </ul>
  );
}
