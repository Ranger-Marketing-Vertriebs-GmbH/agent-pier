import React, { useEffect, useId, useRef, useState } from "react";
import AddPicker from "./AddPicker.jsx";
import GroupLabel from "./GroupLabel.jsx";
import Icon from "./Icon.jsx";
import ListCard from "./ListCard.jsx";
import ListRow from "./ListRow.jsx";
import { filterCandidates, visibleRows } from "./add-picker.js";
import {
  addGrants,
  allowedEntries,
  grantCandidates,
  isAllowed,
  setGrant,
} from "./grant-picker.js";
import { touchQuery } from "./useModalDialog.js";
import useMediaQuery from "../lib/useMediaQuery.js";
import { mediaQueries } from "../lib/breakpoints.js";
import {
  addPickerCopy,
  grantPickerCopy as copy,
} from "../lib/i18n/messages/components.js";
import "./grant-picker.css";

/** The `Modal` className that gives a dialog the width of the split arrangement. */
export const grantDialogClass = "grant-dialog";

const ids = (items) => items.map((item) => item.id);

// The field that takes the focus when no allowed row is left to focus.
const fieldSelector = ".grant-picker-search input, .add-picker-field input";

/**
 * Keeps the keyboard focus in the picker when a click removes the button that had it
 * ("Remove X", "Remove explicit assignment"): it moves to the next allowed row's remove
 * button, else the previous one, else the search or add field. Returns the handler to
 * call with the clicked button before the change.
 */
function useFocusAfterRemove(root) {
  const pending = useRef(null);
  useEffect(() => {
    const target = pending.current;
    if (!target) return;
    pending.current = null;
    if (target.from.isConnected) return;
    const next = [target.next, target.previous].find(
      (button) => button?.isConnected && !button.disabled,
    );
    (next ?? root.current?.querySelector(fieldSelector))?.focus();
  });
  return (button) => {
    const rows = [...root.current.querySelectorAll(".grant-picker-allowed")];
    const index = rows.indexOf(button.closest(".grant-picker-allowed"));
    const removeOf = (row) => row.querySelector("[data-grant-remove]");
    pending.current = {
      from: button,
      next: rows
        .slice(index + 1)
        .map(removeOf)
        .find(Boolean),
      previous: rows.slice(0, Math.max(index, 0)).reverse().map(removeOf).find(Boolean),
    };
  };
}

function AllowedRow({ entry, selected, onChange, disabled, onRemove }) {
  const value = [entry.badge, ...(entry.notes ?? [])].filter(Boolean).join(" · ");
  return (
    <ListRow
      label={entry.name}
      sub={entry.sub}
      value={value}
      className="grant-picker-allowed"
    >
      {entry.action && (
        <button
          type="button"
          className="grant-picker-action"
          disabled={disabled}
          onClick={(event) => {
            onRemove(event.currentTarget);
            entry.action.onClick();
          }}
        >
          {entry.action.label}
        </button>
      )}
      {!entry.locked && (
        <button
          type="button"
          className="list-row-icon-button"
          aria-label={copy.remove(entry.name)}
          data-grant-remove
          disabled={disabled}
          onClick={(event) => {
            onRemove(event.currentTarget);
            onChange(setGrant(selected, entry.id, false));
          }}
        >
          <Icon name="close" />
        </button>
      )}
    </ListRow>
  );
}

function AllowedList({
  headingId,
  heading,
  allowed,
  selected,
  onChange,
  disabled,
  onRemove,
  last,
}) {
  return (
    <div className="grant-picker-allowed-list">
      <GroupLabel as="h3" id={headingId}>
        {heading}
      </GroupLabel>
      <ListCard labelledBy={headingId}>
        {allowed.map((entry) => (
          <AllowedRow
            key={entry.id}
            entry={entry}
            selected={selected}
            onChange={onChange}
            disabled={disabled}
            onRemove={onRemove}
          />
        ))}
        {!allowed.length && !last && (
          <p className="list-row grant-picker-empty">{copy.noneAllowed}</p>
        )}
        {last}
      </ListCard>
    </div>
  );
}

function Choices({ id, entries, selected, onChange, listLabel, disabled, autoFocus }) {
  const [query, setQuery] = useState("");
  const input = useRef(null);
  const matches = filterCandidates(entries, query);
  const { rows, hidden } = visibleRows(matches);

  // Mounted with its Modal, the closed dialog ignores this and `data-autofocus` lets the
  // Modal decide; mounted later (after loading), the field takes focus itself. Touch
  // screens keep the focus where it is, so no on-screen keyboard opens.
  useEffect(() => {
    if (autoFocus && !window.matchMedia?.(touchQuery).matches)
      input.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  return (
    <div className="grant-picker-column">
      <div className="grant-picker-search">
        <input
          ref={input}
          type="search"
          aria-label={copy.search(listLabel)}
          placeholder={copy.search(listLabel)}
          value={query}
          maxLength={200}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          data-autofocus={autoFocus || undefined}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Escape clears a query first, in every engine (Firefox would close the
            // dialog and drop unsaved choices); with an empty field the dialog closes.
            if (event.key !== "Escape" || !query) return;
            event.preventDefault();
            event.stopPropagation();
            setQuery("");
          }}
        />
        <span className="grant-picker-count" role="status">
          {copy.count(matches.length, entries.length)}
        </span>
      </div>
      {/* The div scrolls: a fieldset ignores overflow in some engines. */}
      <div className="grant-picker-list">
        <fieldset disabled={disabled}>
          <legend className="visually-hidden">{listLabel}</legend>
          {rows.map((entry, index) => {
            const rowId = `${id}-row-${index}`;
            const notes = entry.notes?.filter(Boolean) ?? [];
            const described = [
              entry.sub && `${rowId}-sub`,
              notes.length && `${rowId}-notes`,
            ].filter(Boolean);
            return (
              <label key={entry.id} className="grant-picker-row">
                <input
                  type="checkbox"
                  aria-labelledby={`${rowId}-name`}
                  aria-describedby={described.join(" ") || undefined}
                  checked={isAllowed(entry, selected)}
                  disabled={Boolean(entry.locked)}
                  onChange={(event) =>
                    onChange(setGrant(selected, entry.id, event.target.checked))
                  }
                />
                <span className="grant-picker-name" id={`${rowId}-name`}>
                  {entry.name}
                </span>
                {entry.sub && (
                  <span className="grant-picker-sub" id={`${rowId}-sub`}>
                    {entry.sub}
                  </span>
                )}
                {entry.badge && <span className="badge">{entry.badge}</span>}
                {/* Why a locked row cannot be switched off, read as the checkbox's
                    description only: hidden, it is not read a second time, and the
                    allowed list shows the notes. */}
                {notes.length > 0 && (
                  <span hidden id={`${rowId}-notes`}>
                    {notes.join(" · ")}
                  </span>
                )}
              </label>
            );
          })}
          {!matches.length && (
            <p className="grant-picker-note">{copy.noMatches(query.trim())}</p>
          )}
          {hidden > 0 && (
            <p className="grant-picker-note">{addPickerCopy.more(hidden)}</p>
          )}
        </fieldset>
      </div>
    </div>
  );
}

/**
 * Chooses what a session may use from a long list (docs/ui-guide.md#choosing-what-a-
 * session-may-use). `entries` ({ id, name, sub?, group?, badge?, locked?, notes?,
 * action? }) are searched on the left and the allowed ones listed on the right; on
 * phones, or with `stacked`, the allowed list ends in an `AddPicker`. `onChange(ids)`
 * hands the next selected ids to the caller's draft.
 */
export default function GrantPicker({
  entries,
  selected,
  onChange,
  typeLabel,
  listLabel,
  heading,
  stacked = false,
  disabled = false,
  autoFocus = false,
  emptyText,
  children,
}) {
  const id = useId();
  const root = useRef(null);
  const onRemove = useFocusAfterRemove(root);
  const phone = useMediaQuery(mediaQueries.phone);
  if (!entries.length)
    return (
      <>
        <p className="dialog-hint">{emptyText}</p>
        {children}
      </>
    );

  const allowed = allowedEntries(entries, selected);
  const list = {
    headingId: `${id}-heading`,
    heading: heading ?? copy.allowed(allowed.length),
    allowed,
    selected,
    onChange,
    disabled,
    onRemove,
  };

  if (stacked || phone)
    return (
      <div className="grant-picker" data-arrangement="stacked" ref={root}>
        <AllowedList
          {...list}
          last={
            <AddPicker
              typeLabel={typeLabel}
              candidates={grantCandidates(entries)}
              granted={ids(allowed)}
              grantedLabel={copy.allowedTag}
              disabled={disabled}
              onAdd={(items) => onChange(addGrants(selected, ids(items)))}
            />
          }
        />
        {children}
      </div>
    );

  return (
    <div className="grant-picker" data-arrangement="split" ref={root}>
      <Choices
        id={id}
        entries={entries}
        selected={selected}
        onChange={onChange}
        listLabel={listLabel}
        disabled={disabled}
        autoFocus={autoFocus}
      />
      <div className="grant-picker-column grant-picker-side">
        <AllowedList {...list} />
        {children}
      </div>
    </div>
  );
}
