import React, { createContext, useContext, useEffect, useId, useState } from "react";
import StatusDot from "../components/StatusDot.jsx";

// Icon buttons in a group head, by group name: the sidebar provides them for groups
// that other features render (the Agenten group lives in AssistantSidebar).
export const SidebarGroupActions = createContext({});
export default function SidebarGroup({
  name,
  label,
  ariaLabel,
  count,
  defaultOpen = false,
  activeKey = "",
  actions,
  warning = "",
  children,
}) {
  const provided = useContext(SidebarGroupActions)[name];
  const headActions = actions ?? provided;
  const id = useId(),
    storageKey = `agentpier.sidebar.${name}`;
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === "open" || saved === "closed") return saved === "open";
    } catch {}
    return defaultOpen;
  });
  // Reveal a newly selected page without changing the user's saved preference.
  useEffect(() => {
    if (activeKey) setOpen(true);
  }, [activeKey]);
  function toggle() {
    setOpen((value) => {
      const next = !value;
      try {
        localStorage.setItem(storageKey, next ? "open" : "closed");
      } catch {}
      return next;
    });
  }
  return (
    <section
      className={`sidebar-group ${name}-group ${open ? "expanded" : "collapsed"} ${activeKey ? "active" : ""}`}
    >
      <div className="sidebar-group-head">
        <button
          className="sidebar-group-toggle"
          aria-label={ariaLabel || label}
          aria-expanded={open}
          aria-controls={id}
          onClick={toggle}
        >
          <span className="sidebar-group-chevron" aria-hidden="true">
            ›
          </span>
          <span>{label}</span>
          {warning && (
            <StatusDot tone="warning" label={warning} className="sidebar-group-warning" />
          )}
          {count !== undefined && <span className="sidebar-group-count">{count}</span>}
        </button>
        {headActions && <div className="sidebar-group-actions">{headActions}</div>}
      </div>
      <div className="sidebar-group-content" id={id} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
export {
  sessionActivity,
  sandboxBadge,
} from "../features/sessions/sessionPresentation.js";
