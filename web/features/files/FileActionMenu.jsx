import React, { useEffect, useRef, useState } from "react";
import Icon from "../../components/Icon.jsx";

export default function FileActionMenu({ label, icon = "menu", items, compact = false }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const visibleItems = items.filter((item) => !item.hidden);

  const close = (restore = true) => {
    setOpen(false);
    if (restore) queueMicrotask(() => trigger.current?.focus());
  };
  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector("[role='menuitem']:not(:disabled)")?.focus();
    const outside = (event) => {
      if (!root.current?.contains(event.target)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  return (
    <div className="file-action-menu" ref={root}>
      <button
        type="button"
        ref={trigger}
        className={`button secondary compact ${compact ? "icon-button" : ""}`}
        aria-label={compact ? label : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={icon} />
        {!compact && <span>{label}</span>}
      </button>
      {open && (
        <div
          role="menu"
          ref={menu}
          aria-label={label}
          className="file-action-popover"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            const controls = [
              ...event.currentTarget.querySelectorAll("[role='menuitem']:not(:disabled)"),
            ];
            const position = controls.indexOf(document.activeElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? controls.length - 1
                  : event.key === "ArrowDown"
                    ? (position + 1) % controls.length
                    : event.key === "ArrowUp"
                      ? (position - 1 + controls.length) % controls.length
                      : null;
            if (next !== null) {
              event.preventDefault();
              controls[next]?.focus();
            }
          }}
        >
          {visibleItems.map((item) => (
            <button
              key={item.kind}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onClick({ restoreFocus: () => trigger.current?.focus() });
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
