import React, { useEffect, useId, useRef, useState } from "react";
import "./search-select.css";

export default function SearchSelect({
  label,
  searchLabel,
  value,
  selectedLabel,
  placeholder,
  options,
  onChange,
  query,
  onQuery,
  busy,
  footer,
}) {
  const [open, setOpen] = useState(false);
  const [localQuery, setLocalQuery] = useState("");
  const [active, setActive] = useState(-1);
  const root = useRef(null),
    trigger = useRef(null),
    input = useRef(null);
  const id = useId();
  const search = query ?? localQuery;
  const filtered = onQuery
    ? options
    : options.filter((option) =>
        option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
      );
  const selected =
    selectedLabel ||
    options.find((option) => option.value === value)?.label ||
    placeholder;
  function choose(option) {
    if (busy || !option) return;
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    input.current?.focus({ preventScroll: true });
    const outside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (active >= 0)
      document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, id]);
  return (
    <div
      className="search-select"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span className="search-select-label">{label}</span>
      <button
        ref={trigger}
        type="button"
        className="search-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setActive(-1);
        }}
      >
        <span>{selected}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="search-select-panel">
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-label={searchLabel}
            aria-expanded="true"
            aria-controls={id}
            aria-autocomplete="list"
            aria-activedescendant={
              !busy && filtered[active] ? `${id}-${active}` : undefined
            }
            value={search}
            maxLength={200}
            autoCapitalize="none"
            spellCheck={false}
            placeholder={searchLabel}
            onChange={(event) => {
              (onQuery || setLocalQuery)(event.target.value);
              setActive(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                trigger.current?.focus();
              }
              if (event.key === "Enter") {
                event.preventDefault();
                choose(filtered[active]);
              }
              if (["ArrowDown", "ArrowUp"].includes(event.key)) {
                event.preventDefault();
                setActive((current) =>
                  Math.max(
                    0,
                    Math.min(
                      filtered.length - 1,
                      current + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  ),
                );
              }
            }}
          />
          <div
            id={id}
            role="listbox"
            aria-label={label}
            aria-busy={busy}
            className="search-select-options"
          >
            {filtered.map((option, index) => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                disabled={busy}
                id={`${id}-${index}`}
                key={option.value}
                className={active === index ? "active" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {footer}
        </div>
      )}
    </div>
  );
}
