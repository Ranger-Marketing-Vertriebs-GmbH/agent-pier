import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// ⋯ menus of list rows. List cards clip their rows, so the popover is fixed to the
// viewport under its trigger (above it when there is no room below); it closes on
// outside press, scroll, resize and Escape.
export function useRowMenu() {
  const [position, setPosition] = useState(null);
  const trigger = useRef(null);
  const close = useCallback((restore = true) => {
    setPosition(null);
    if (restore) queueMicrotask(() => trigger.current?.focus());
  }, []);
  const toggle = useCallback((event) => {
    trigger.current = event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    setPosition((open) =>
      open
        ? null
        : {
            top: rect.bottom + 4,
            right: Math.max(8, document.documentElement.clientWidth - rect.right),
          },
    );
  }, []);
  return { open: position !== null, position, trigger, close, toggle };
}

const enabledItems = (menu) => [
  ...menu.querySelectorAll("[role='menuitem']:not(:disabled)"),
];

export function RowMenu({ label, state, items }) {
  const menu = useRef(null);
  const { open, close, trigger, position } = state;
  // Near the bottom edge the menu opens above its trigger, never below the viewport.
  useLayoutEffect(() => {
    const node = menu.current;
    const anchor = trigger.current?.getBoundingClientRect();
    if (!open || !node || !anchor) return;
    const { height } = node.getBoundingClientRect();
    if (position.top + height > window.innerHeight - 8)
      node.style.top = `${Math.max(8, anchor.top - height - 4)}px`;
  }, [open, position, trigger]);
  useEffect(() => {
    if (!open) return undefined;
    enabledItems(menu.current)[0]?.focus({ preventScroll: true });
    const outside = (event) => {
      if (
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        close(false);
    };
    const dismiss = (event) => {
      if (!(event.target instanceof Node) || !menu.current?.contains(event.target))
        close(false);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open, close, trigger]);
  if (!open) return null;
  return (
    <div
      role="menu"
      ref={menu}
      aria-label={label}
      className="row-menu"
      style={{ top: position.top, right: position.right }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (event.key === "Tab") {
          close(false);
          return;
        }
        const controls = enabledItems(event.currentTarget);
        const index = controls.indexOf(document.activeElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? controls.length - 1
              : event.key === "ArrowDown"
                ? (index + 1) % controls.length
                : event.key === "ArrowUp"
                  ? (index - 1 + controls.length) % controls.length
                  : null;
        if (next !== null) {
          event.preventDefault();
          controls[next]?.focus();
        }
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          aria-label={item.ariaLabel}
          className={item.danger ? "danger" : undefined}
          disabled={item.disabled}
          onClick={() => {
            close(item.restoreFocus !== false);
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
