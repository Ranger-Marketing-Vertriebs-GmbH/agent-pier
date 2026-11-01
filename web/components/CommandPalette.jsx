import React, { useEffect, useId, useRef, useState } from "react";
import Modal from "./Modal.jsx";
import Icon from "./Icon.jsx";
import ErrorMessage from "./ErrorMessage.jsx";
import "./command-palette.css";

/**
 * A quick-open palette: a `Modal` with a search field (an ARIA 1.2 combobox) over
 * grouped results (a listbox with one labelled group each). The caller filters:
 * `query` and `onQueryChange` hold the field, `groups` (`[{ id, label, items }]`,
 * each item `{ id, label, detail, icon }`, `icon` a node) are the results to show.
 * Arrows move (wrapping), Home and End jump, Enter calls `onChoose(item)`, Escape
 * closes and the opener gets the focus back. `empty` (`{ title, hint, resetLabel }`)
 * words the state without results and offers to clear the field; `status` is the
 * live count, `loading` a status line, `error` an alert when a chosen result failed,
 * `keys` the key hints of the footer (hidden on phones, where the palette is a bottom
 * sheet).
 */
export default function CommandPalette({
  title,
  close,
  query,
  onQueryChange,
  groups,
  onChoose,
  inputLabel,
  placeholder,
  resultsLabel,
  status = "",
  loading = "",
  error = "",
  empty = null,
  keys = [],
  className = "",
}) {
  const [active, setActive] = useState(0);
  const input = useRef(null);
  const list = useRef(null);
  const id = useId();
  const items = groups.flatMap((group) => group.items);
  const current = Math.min(active, items.length - 1);
  const optionId = (position) => `${id}-option-${position}`;
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (current < 0) return;
    list.current
      ?.querySelectorAll('[role="option"]')
      [current]?.scrollIntoView?.({ block: "nearest" });
  }, [current, groups]);
  // Escape closes the dialog (Modal); stopping it at the document keeps it from also
  // closing a phone drawer behind the palette (one layer per press).
  useEffect(() => {
    const escape = (event) => {
      if (event.key === "Escape") event.stopPropagation();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, []);
  const onKeyDown = (event) => {
    const last = items.length - 1;
    const moves = {
      ArrowDown: (current + 1) % items.length,
      ArrowUp: (current - 1 + items.length) % items.length,
      // Home and End stay with the text field once it holds text.
      ...(query ? {} : { Home: 0, End: last }),
    };
    if (event.key in moves) {
      event.preventDefault();
      if (items.length) setActive(moves[event.key]);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (items[current]) onChoose(items[current]);
    }
  };
  let position = -1;
  return (
    <Modal
      title={title}
      close={close}
      className={["command-palette", className].filter(Boolean).join(" ")}
      dismissOnBackdrop
    >
      <div className="command-palette-field">
        <Icon name="search" size={18} />
        <input
          ref={input}
          data-search-input=""
          data-autofocus=""
          type="text"
          inputMode="search"
          enterKeyHint="go"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-label={inputLabel}
          aria-expanded={items.length > 0}
          aria-controls={`${id}-results`}
          aria-autocomplete="list"
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          placeholder={placeholder}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <span className="command-palette-count" role="status">
          {status}
        </span>
      </div>
      <div
        ref={list}
        id={`${id}-results`}
        role="listbox"
        aria-label={resultsLabel}
        className="command-palette-results"
      >
        {groups.map((group) => (
          <div
            key={group.id}
            role="group"
            aria-labelledby={`${id}-${group.id}`}
            className="command-palette-group"
          >
            <div id={`${id}-${group.id}`} className="command-palette-group-label">
              {group.label}
            </div>
            {group.items.map((item) => {
              position += 1;
              const at = position;
              const selected = at === current;
              return (
                <div
                  key={item.id}
                  id={optionId(at)}
                  role="option"
                  aria-selected={selected}
                  className={
                    selected ? "command-palette-option active" : "command-palette-option"
                  }
                  onMouseMove={() => !selected && setActive(at)}
                  // The field keeps the focus, so typing continues after a tap.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onChoose(item)}
                >
                  <span className="command-palette-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="command-palette-text">
                    <span className="command-palette-label">{item.label}</span>
                    {item.detail && (
                      <span className="command-palette-detail">{item.detail}</span>
                    )}
                  </span>
                  {selected && (
                    <span className="command-palette-key" aria-hidden="true">
                      ↵
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {!items.length && empty && (
        <div className="command-palette-empty">
          <p className="command-palette-empty-title">{empty.title}</p>
          {empty.hint && <p>{empty.hint}</p>}
          {query && empty.resetLabel && (
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                onQueryChange("");
                input.current?.focus();
              }}
            >
              {empty.resetLabel}
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="command-palette-error">
          <ErrorMessage error={error} />
        </div>
      )}
      {loading && (
        <p className="command-palette-loading" role="status">
          {loading}
        </p>
      )}
      {keys.length > 0 && (
        <div className="command-palette-keys" aria-hidden="true">
          {keys.map((key) => (
            <span key={key}>{key}</span>
          ))}
        </div>
      )}
    </Modal>
  );
}
