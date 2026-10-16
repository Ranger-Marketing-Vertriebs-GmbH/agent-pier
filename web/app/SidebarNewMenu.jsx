import React, { useEffect, useRef, useState } from "react";
import Icon from "../components/Icon.jsx";
import { sidebarCopy as copy } from "../lib/i18n/messages/app.js";

// The orange "+ New" button: a small menu with the two things the owner can create.
// `icon` renders the compact "+" of the phone header and the collapsed sidebar; `align`
// keeps the popover inside the viewport ("right" under the header's "+").
export default function SidebarNewMenu({
  items,
  disabled,
  icon = false,
  align = "left",
}) {
  const [open, setOpen] = useState(false);
  const root = useRef(null),
    trigger = useRef(null),
    menu = useRef(null);
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
      // One layer at a time: the phone drawer stays open behind the menu.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      trigger.current?.focus();
      setOpen(false);
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
    <div className={`new-menu ${icon ? "new-menu-icon" : ""}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={icon ? "icon-button" : "button primary new-session"}
        aria-label={icon ? copy.newLabel : undefined}
        title={icon ? copy.newLabel : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="plus" />
        {!icon && copy.newLabel}
      </button>
      {open && (
        <div
          role="menu"
          ref={menu}
          aria-label={copy.newLabel}
          className={`new-menu-popover ${align === "right" ? "align-right" : ""}`}
          onKeyDown={keys}
          onBlur={(event) => {
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
