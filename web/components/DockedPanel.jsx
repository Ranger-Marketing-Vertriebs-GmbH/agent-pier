import React, { useId } from "react";
import Icon from "./Icon.jsx";
import "./docked-panel.css";

/**
 * A non-modal panel docked at the right of its parent (a flex row with
 * `position: relative`), beside the page's content, which stays usable: the agent
 * chat's pinboard. On phones it covers its parent. `SidePanel` is the modal one.
 */
export default function DockedPanel({ title, subtitle, onClose, closeLabel, children }) {
  const titleId = useId();
  return (
    <aside className="docked-panel" aria-labelledby={titleId}>
      <div className="docked-panel-heading">
        <div className="docked-panel-titles">
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="docked-panel-body">{children}</div>
    </aside>
  );
}
