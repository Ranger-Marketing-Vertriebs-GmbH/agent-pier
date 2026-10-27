import React, { useId, useState } from "react";
import FilterChips from "../../components/FilterChips.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import { startPageCopy as copy } from "../../lib/i18n/messages/dashboard.js";
import { filterList, PHONE_LIMIT, shownRows } from "./start-lists.js";

/**
 * A start page card with a long list (sessions, agents): title and count, a search
 * (beside the title; above the chips on phones), filter chips with counts after the
 * search, the first `limit` rows and "Show n more", which lets the list scroll inside
 * the card. Changing the filter or the search folds it again. Phones show
 * `PHONE_LIMIT` rows and a "show all" row (`showAll(count)` → `{ label, onClick }`)
 * instead. `error` (such as a failed open) shows on both layouts.
 */
export default function StartListCard({
  id,
  title,
  count,
  items,
  filters,
  filterLabels,
  filterDots = {},
  chipsLabel,
  searchLabel,
  limit,
  order,
  empty,
  noMatch,
  footer = null,
  error = "",
  showAll,
  phone,
  className = "",
  children,
}) {
  const [filter, setFilter] = useState(Object.keys(filters)[0]);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const { counts, rows } = filterList(items, { filters, filter, query });
  const visible = phone
    ? shownRows(rows, PHONE_LIMIT, false)
    : shownRows(rows, limit, expanded);
  const hidden = rows.length - shownRows(rows, limit, false).length;
  const search = (
    <label className="start-search">
      <Icon name="search" size={14} />
      <input
        type="search"
        value={query}
        placeholder={searchLabel}
        aria-label={searchLabel}
        onChange={(event) => {
          setQuery(event.target.value);
          setExpanded(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.preventDefault();
            setQuery("");
            setExpanded(false);
          }
        }}
      />
    </label>
  );
  const all = showAll && phone && rows.length > PHONE_LIMIT ? showAll(rows.length) : null;
  return (
    <section
      className={`start-card start-list ${className}`.trim()}
      aria-labelledby={`${id}-title`}
    >
      <div className="start-card-head">
        <h2 id={`${id}-title`}>
          {title} {count && <span className="start-card-count">{count}</span>}
        </h2>
        {!phone && items.length > 0 && search}
      </div>
      {phone && items.length > 0 && search}
      {items.length > 0 && (
        <FilterChips
          label={chipsLabel}
          value={filter}
          onChange={(next) => {
            setFilter(next);
            setExpanded(false);
          }}
          options={Object.keys(filters).map((value) => ({
            value,
            label: filterLabels[value],
            count: counts[value],
            dot: filterDots[value],
          }))}
        />
      )}
      <div
        id={listId}
        className={`start-list-body ${expanded && !phone ? "expanded" : ""}`}
      >
        {items.length === 0 ? (
          <p className="start-empty">{empty}</p>
        ) : rows.length === 0 ? (
          <p className="start-empty" role="status">
            {noMatch}
          </p>
        ) : (
          children(visible)
        )}
      </div>
      <ErrorMessage error={error} />
      {all && (
        <button type="button" className="start-show-all" onClick={all.onClick}>
          {all.label}
          <Icon name="chevron" size={14} />
        </button>
      )}
      {!phone && (footer || rows.length > 0) && (
        <div className="start-card-foot">
          {footer || (
            <p className="start-card-note" aria-live="polite">
              {copy.shownOf(visible.length, rows.length)} · {order}
            </p>
          )}
          {hidden > 0 && (
            <button
              type="button"
              className="button secondary compact"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? copy.showLess : copy.showMore(hidden)}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
