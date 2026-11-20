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

function AllowedRow({ entry, selected, onChange, disabled }) {
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
          onClick={entry.action.onClick}
        >
          {entry.action.label}
        </button>
      )}
      {!entry.locked && (
        <button
          type="button"
          className="list-row-icon-button"
          aria-label={copy.remove(entry.name)}
          disabled={disabled}
          onClick={() => onChange(setGrant(selected, entry.id, false))}
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
            return (
              <label key={entry.id} className="grant-picker-row">
                <input
                  type="checkbox"
                  aria-labelledby={`${rowId}-name`}
                  aria-describedby={entry.sub ? `${rowId}-sub` : undefined}
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
  };

  if (stacked || phone)
    return (
      <div className="grant-picker" data-arrangement="stacked">
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
    <div className="grant-picker" data-arrangement="split">
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
