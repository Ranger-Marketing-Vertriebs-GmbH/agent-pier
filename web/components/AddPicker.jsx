import React, { useEffect, useId, useReducer, useRef, useState } from "react";
import AnchoredSelect from "./AnchoredSelect.jsx";
import ErrorMessage from "./ErrorMessage.jsx";
import Icon from "./Icon.jsx";
import {
  defaultRowLimit,
  filterCandidates,
  initialPickerState,
  itemsToAdd,
  keyIntent,
  markGranted,
  pickerReducer,
  searchDelay,
  visibleRows,
} from "./add-picker.js";
import { addPickerCopy as copy } from "../lib/i18n/messages/components.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import "./add-picker.css";

const asResult = (result) =>
  Array.isArray(result)
    ? { items: result, total: result.length }
    : { items: result?.items ?? [], total: result?.total ?? result?.items?.length ?? 0 };

/**
 * The inline add field: the last row of a list card (docs/ui-guide.md#rows-and-controls).
 * Typing filters `candidates` ({ id, name, sub?, group?, granted? }) or, with an async
 * `search(query, { signal })` (stable identity, returns items or { items, total }), asks
 * the server after a short pause. Rows are checked in an attached listbox; already
 * `granted` ids stay visible but disabled. `modes` ({ value, label }) offers one mode
 * for all new items. `onAdd(items, mode)` hands the choice to the caller's draft.
 */
export default function AddPicker({
  typeLabel,
  candidates = [],
  search,
  granted,
  grantedLabel = copy.alreadyGranted,
  modes,
  defaultMode,
  onAdd,
  limit = defaultRowLimit,
  disabled = false,
}) {
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (index) => `${id}-option-${index}`;
  const root = useRef(null),
    input = useRef(null);
  const [state, dispatch] = useReducer(
    pickerReducer,
    defaultMode ?? modes?.[0]?.value ?? null,
    initialPickerState,
  );
  const [remote, setRemote] = useState({ items: [], total: 0, busy: false, error: "" });

  const matches = markGranted(
    search ? remote.items : filterCandidates(candidates, state.query),
    granted,
  );
  const total = search ? Math.max(remote.total, matches.length) : matches.length;
  const { rows } = visibleRows(matches, limit);
  const hidden = Math.max(0, total - rows.length);
  const selectedIds = new Set(state.selected.map((item) => item.id));
  const activeRow = state.open ? rows[state.active] : undefined;

  useEffect(() => {
    if (!search || !state.open) return undefined;
    const controller = new AbortController();
    setRemote((current) => ({ ...current, busy: true, error: "" }));
    const timer = setTimeout(async () => {
      try {
        const result = asResult(await search(state.query, { signal: controller.signal }));
        if (!controller.signal.aborted) setRemote({ ...result, busy: false, error: "" });
      } catch {
        if (!controller.signal.aborted)
          setRemote({ items: [], total: 0, busy: false, error: copy.searchFailed });
      }
    }, searchDelay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search, state.query, state.open]);

  useEffect(() => {
    if (activeRow)
      document
        .getElementById(optionId(state.active))
        ?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.active, state.open]);

  useEffect(() => {
    if (!state.open || state.selected.length) return undefined;
    // A click elsewhere closes an untouched list; checked items keep it open.
    const outside = (event) => {
      if (!root.current?.contains(event.target)) dispatch({ type: "close" });
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [state.open, state.selected.length]);

  function finish(items) {
    if (items?.length) onAdd(items, state.mode);
    dispatch({ type: "reset" });
    input.current?.focus();
  }

  function onKeyDown(event) {
    const intent = keyIntent(event.key, state);
    if (!intent) return;
    if (intent === "clear") {
      if (!state.query && !state.selected.length) return;
      finish();
    } else if (intent === "close") {
      dispatch({ type: "close" });
    } else if (intent === "toggle") {
      dispatch({ type: "toggleActive", rows });
    } else if (intent === "add") {
      const items = itemsToAdd(state, rows);
      if (items.length) finish(items);
    } else {
      dispatch({ type: "move", intent, rows });
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function onPanelKeyDown(event) {
    // Escape from the mode select or a footer button closes and returns to the field.
    if (event.key !== "Escape" || event.target === input.current) return;
    event.preventDefault();
    event.stopPropagation();
    dispatch({ type: "close" });
    input.current?.focus();
  }

  const status = remote.busy ? copy.searching : copy.matches(total);

  return (
    <div className="add-picker" ref={root} onKeyDown={onPanelKeyDown}>
      <div className="list-row add-picker-field">
        <Icon name="plus" size={16} className="add-picker-plus" />
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label={copy.fieldLabel(typeLabel)}
          aria-expanded={state.open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeRow ? optionId(state.active) : undefined}
          placeholder={copy.placeholder(typeLabel)}
          value={state.query}
          disabled={disabled}
          maxLength={200}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => dispatch({ type: "query", query: event.target.value })}
          onClick={() => dispatch({ type: "open" })}
          onKeyDown={onKeyDown}
        />
        <span className="add-picker-count" role="status">
          {state.open ? status : ""}
        </span>
      </div>
      {state.open && (
        <div className="add-picker-panel">
          <div
            id={listId}
            role="listbox"
            aria-multiselectable="true"
            aria-label={copy.listLabel(typeLabel)}
            aria-busy={remote.busy || undefined}
            tabIndex={-1}
            // Clicks keep the focus in the field (active descendant pattern).
            onMouseDown={(event) => event.preventDefault()}
            className="add-picker-options"
          >
            {rows.map((row, index) => {
              const checked = row.granted || selectedIds.has(row.id);
              return (
                <div
                  key={row.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={checked}
                  aria-disabled={row.granted || undefined}
                  className={[
                    "add-picker-option",
                    index === state.active ? "is-active" : "",
                    row.granted ? "is-granted" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => dispatch({ type: "toggle", candidate: row })}
                >
                  <span className="add-picker-check" data-checked={checked} />
                  <span className="add-picker-text">
                    <span className="add-picker-name">{row.name}</span>
                    {row.sub && <span className="add-picker-sub">{row.sub}</span>}
                  </span>
                  {row.granted ? (
                    <span className="add-picker-meta">{grantedLabel}</span>
                  ) : (
                    row.group && <span className="add-picker-meta">{row.group}</span>
                  )}
                </div>
              );
            })}
          </div>
          {!rows.length && !remote.busy && !remote.error && (
            <p className="add-picker-note">{copy.noMatches}</p>
          )}
          {hidden > 0 && <p className="add-picker-note">{copy.more(hidden)}</p>}
          <ErrorMessage error={remote.error} className="error add-picker-note" />
          <div className="add-picker-footer">
            {modes?.length > 0 && (
              <div className="add-picker-mode">
                <span aria-hidden="true">{copy.mode}</span>
                <AnchoredSelect
                  label={copy.modeLabel}
                  value={state.mode}
                  options={modes}
                  onChange={(mode) => dispatch({ type: "mode", mode })}
                />
              </div>
            )}
            <div className="add-picker-actions">
              <button
                type="button"
                className="button secondary compact"
                onClick={() => finish()}
              >
                {commonCopy.cancel}
              </button>
              <button
                type="button"
                className="button primary compact"
                disabled={!state.selected.length}
                onClick={() => finish(state.selected)}
              >
                {copy.add(state.selected.length)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
