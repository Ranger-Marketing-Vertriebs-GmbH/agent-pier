import React, { useEffect, useRef, useState } from "react";
import Icon from "../../components/Icon.jsx";

// The phone header's "+": a small menu with the page's two ways to add a project.
export default function ProjectAddMenu({ label, items }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector("[role='menuitem']")?.focus();
    const outside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const keys = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    const controls = [...event.currentTarget.querySelectorAll("[role='menuitem']")];
    const position = controls.indexOf(document.activeElement);
    const next =
      event.key === "ArrowDown"
        ? (position + 1) % controls.length
        : event.key === "ArrowUp"
          ? (position - 1 + controls.length) % controls.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? controls.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    controls[next].focus();
  };
  return (
    <div className="project-add-menu" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="project-add-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="plus" />
      </button>
      {open && (
        <div
          role="menu"
          ref={menu}
          aria-label={label}
          className="project-add-popover"
          onKeyDown={keys}
          onBlur={(event) => {
            // Tabbing out of the menu closes it, like a pointer press outside.
            const next = event.relatedTarget;
            if (next && !root.current?.contains(next)) setOpen(false);
          }}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => {
                // Focus the trigger first so a dialog opened next returns focus there.
                trigger.current?.focus();
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
