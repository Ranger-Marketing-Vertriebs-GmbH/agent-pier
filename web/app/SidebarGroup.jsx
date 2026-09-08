import React, { useEffect, useId, useState } from "react";
export default function SidebarGroup({
  name,
  label,
  count,
  defaultOpen = false,
  activeKey = "",
  children,
}) {
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
      <button
        className="sidebar-group-toggle"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
      >
        <span className="sidebar-group-chevron" aria-hidden="true">
          ›
        </span>
        <span>{label}</span>
        {count !== undefined && <span className="sidebar-group-count">{count}</span>}
      </button>
      <div className="sidebar-group-content" id={id} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
export { sessionActivity } from "../features/sessions/sessionPresentation.js";
