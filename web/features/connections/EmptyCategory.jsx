import React from "react";
import Icon from "../../components/Icon.jsx";

/**
 * An empty Zugänge category (RZustaende "Keine Einträge"): what is missing, what it is
 * for and the actions that fill it, with the same verbs as the category's add button.
 */
export default function EmptyCategory({ icon = "shield", title, body, actions = [] }) {
  return (
    <div className="connections-empty">
      <span className="connections-empty-icon" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {actions.length > 0 && (
        <div className="connections-actions">
          {actions.map((action, index) => (
            <button
              key={action.label}
              type="button"
              className={`button ${index === 0 ? "primary" : "secondary"}`}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
