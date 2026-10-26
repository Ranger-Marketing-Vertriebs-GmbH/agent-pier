import React, { useEffect, useId, useMemo, useRef } from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import Icon from "../../components/Icon.jsx";
import Segmented from "../../components/Segmented.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import { activeFilters, listModel, nextRow } from "./long-list.js";
import "./long-list.css";

function Toolbar({
  state,
  dispatch,
  searchPlaceholder,
  filters,
  groupOptions,
  sortOptions,
}) {
  return (
    <div className="long-list-toolbar">
      <input
        type="search"
        className="long-list-search"
        aria-label={copy.searchLabel}
        placeholder={searchPlaceholder}
        value={state.query}
        onChange={(event) => dispatch({ type: "query", query: event.target.value })}
      />
      {filters.map((filter) => (
        <div
          key={filter.key}
          className={["long-list-chip", state.filters[filter.key] ? "is-active" : ""]
            .filter(Boolean)
            .join(" ")}
        >
          <AnchoredSelect
            label={filter.label}
            value={state.filters[filter.key] ?? ""}
            onChange={(value) => dispatch({ type: "filter", key: filter.key, value })}
            options={[
              { value: "", label: copy.filterAll(filter.label) },
              ...filter.options,
            ]}
          />
        </div>
      ))}
      {groupOptions.length > 0 && (
        <label className="long-list-choice">
          <span>{copy.groupBy}</span>
          <AnchoredSelect
            label={copy.groupBy}
            value={state.groupBy}
            onChange={(groupBy) => dispatch({ type: "groupBy", groupBy })}
            options={groupOptions}
          />
        </label>
      )}
      <label className="long-list-choice">
        <span>{copy.sortBy}</span>
        <AnchoredSelect
          label={copy.sortBy}
          value={state.sort}
          onChange={(sort) => dispatch({ type: "sort", sort })}
          options={sortOptions}
        />
      </label>
    </div>
  );
}

function Row({
  item,
  cells,
  selected,
  active,
  dispatch,
  onOpen,
  onKey,
  rowRef,
  idPrefix,
}) {
  const describedBy = [
    "sub",
    ...(cells.description ? ["desc"] : []),
    "type",
    "used",
    "status",
    "last",
  ]
    .map((part) => `${idPrefix}-${item.id}-${part}`)
    .join(" ");
  return (
    <li
      className={[
        "long-list-row",
        active ? "is-active" : "",
        item.problem ? "has-problem" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <label className="long-list-check">
        <input
          type="checkbox"
          className="checkbox"
          aria-label={copy.selectRow(item.name)}
          checked={selected}
          onChange={() => dispatch({ type: "select", id: item.id })}
        />
      </label>
      <button
        ref={rowRef}
        type="button"
        className="long-list-open"
        aria-label={item.name}
        aria-describedby={describedBy}
        aria-current={active ? "true" : undefined}
        onClick={() => onOpen(item)}
        onKeyDown={(event) => onKey(event, item)}
      >
        <span className="long-list-name">
          <strong>{item.name}</strong>
          <span id={`${idPrefix}-${item.id}-sub`}>{item.sub}</span>
          {cells.description && (
            <span className="visually-hidden" id={`${idPrefix}-${item.id}-desc`}>
              {cells.description}
            </span>
          )}
        </span>
      </button>
      <span className="long-list-type" id={`${idPrefix}-${item.id}-type`}>
        <span className="badge">{cells.type}</span>
      </span>
      <span className="long-list-used" id={`${idPrefix}-${item.id}-used`}>
        {cells.usedBy}
      </span>
      <span
        className={`long-list-status is-${cells.status.tone}`}
        id={`${idPrefix}-${item.id}-status`}
      >
        <StatusDot tone={cells.status.tone} />
        {cells.status.text}
      </span>
      <span className="long-list-last" id={`${idPrefix}-${item.id}-last`}>
        {cells.last}
      </span>
    </li>
  );
}

/**
 * The dense list of a Zugänge category (handoff 5.6): views, search, filter chips,
 * grouping with "Weitere n anzeigen", sorting, selection for bulk actions and a
 * keyboard path (arrows move, Space selects, Enter opens). Pure rules: long-list.js.
 */
export default function LongList({
  label,
  items,
  state,
  dispatch,
  groupOf,
  views = ["all", "problems", "unused"],
  viewNote,
  searchPlaceholder,
  filters = [],
  groupOptions = [],
  sortOptions,
  columns,
  cells,
  activeId,
  onOpen,
  bulk,
  bulkOpen = false,
  empty,
}) {
  const idPrefix = useId();
  const rowRefs = useRef(new Map());
  const model = useMemo(() => listModel(items, state, groupOf), [items, state, groupOf]);
  const ids = items.map((item) => item.id).join(" ");
  useEffect(() => {
    dispatch({ type: "prune", ids: ids ? ids.split(" ") : [] });
  }, [ids, dispatch]);
  const onKey = (event, item) => {
    if (event.key === " ") {
      event.preventDefault();
      dispatch({ type: "select", id: item.id });
      return;
    }
    const next = nextRow(model.visible, item.id, event.key);
    if (!next) return;
    event.preventDefault();
    rowRefs.current.get(next)?.focus();
  };
  if (!items.length) return empty ?? null;
  const filtered = activeFilters(state.filters).length;
  const viewOptions = views.map((view) => ({
    value: view,
    label:
      view === "problems"
        ? copy.views.problems(model.counts.problems)
        : view === "unused"
          ? copy.views.unused(model.counts.unused)
          : copy.views[view],
    title: view === "today" ? viewNote : undefined,
  }));
  const visibleSelected =
    model.visible.length > 0 && model.visible.every((id) => state.selected.includes(id));
  const showNote = viewNote && (state.view === "today" || state.sort === "used");
  return (
    <div className="long-list">
      <Segmented
        label={copy.views.label}
        className="long-list-views"
        value={state.view}
        onChange={(view) => dispatch({ type: "view", view })}
        options={viewOptions}
      />
      {showNote && <p className="long-list-note">{viewNote}</p>}
      <Toolbar
        state={state}
        dispatch={dispatch}
        searchPlaceholder={searchPlaceholder}
        filters={filters}
        groupOptions={groupOptions}
        sortOptions={sortOptions}
      />
      {(state.selected.length > 0 || bulkOpen) && (
        <div className="long-list-bulk" role="region" aria-label={copy.bulkLabel}>
          <span className="long-list-bulk-count" role="status">
            {copy.selected(state.selected.length)}
          </span>
          {bulk}
          <button
            type="button"
            className="button secondary compact"
            onClick={() => dispatch({ type: "clearSelection" })}
          >
            {copy.clearSelection}
          </button>
        </div>
      )}
      {model.matching === 0 ? (
        <div className="long-list-empty" role="status">
          <h3>{copy.noMatches(state.query.trim())}</h3>
          {filtered > 0 && <p>{copy.activeFilters(filtered)}</p>}
          <button
            type="button"
            className="button secondary"
            onClick={() => dispatch({ type: "reset" })}
          >
            {copy.resetFilters}
          </button>
        </div>
      ) : (
        <div className="long-list-table">
          <div className="long-list-head">
            <label className="long-list-check">
              <input
                type="checkbox"
                className="checkbox"
                aria-label={copy.selectVisible}
                checked={visibleSelected}
                onChange={() => dispatch({ type: "selectAll", ids: model.visible })}
              />
            </label>
            <span aria-hidden="true">{copy.columns.name}</span>
            <span aria-hidden="true">{columns.type}</span>
            <span aria-hidden="true">{copy.columns.usedBy}</span>
            <span aria-hidden="true">{copy.columns.status}</span>
            <span aria-hidden="true">{columns.last}</span>
          </div>
          {model.groups.map((group) => (
            <div key={group.key} className="long-list-group">
              {group.label && (
                <button
                  type="button"
                  className="long-list-group-head"
                  aria-expanded={!group.collapsed}
                  onClick={() => dispatch({ type: "collapse", key: group.key })}
                >
                  <Icon name={group.collapsed ? "chevron" : "down"} size={14} />
                  <span>{group.label}</span>
                  <small>{copy.groupCount(group.total)}</small>
                  {group.problems > 0 && (
                    <small className="long-list-group-problems">
                      {copy.groupProblems(group.problems)}
                    </small>
                  )}
                </button>
              )}
              {!group.collapsed && (
                <ul aria-label={group.label || label}>
                  {group.rows.map((item) => (
                    <Row
                      key={item.id}
                      item={item}
                      cells={cells(item)}
                      selected={state.selected.includes(item.id)}
                      active={item.id === activeId}
                      dispatch={dispatch}
                      onOpen={onOpen}
                      onKey={onKey}
                      idPrefix={idPrefix}
                      rowRef={(node) => {
                        if (node) rowRefs.current.set(item.id, node);
                        else rowRefs.current.delete(item.id);
                      }}
                    />
                  ))}
                </ul>
              )}
              {group.more > 0 && (
                <button
                  type="button"
                  className="long-list-more"
                  onClick={() => dispatch({ type: "expand", key: group.key })}
                >
                  {copy.showMore(group.more)}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="long-list-footer">
        <span>
          {copy.footer(
            model.matching,
            model.groups.filter((group) => group.label).length,
            model.problems,
          )}
        </span>
        <span className="long-list-keys">{copy.keyboardHint}</span>
      </p>
    </div>
  );
}
