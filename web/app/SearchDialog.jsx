import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import Modal from "../components/Modal.jsx";
import Icon from "../components/Icon.jsx";
import { getLanguage } from "../lib/i18n/index.js";
import { searchCopy as copy } from "../lib/i18n/messages/search.js";
import { buildSearchIndex } from "./search-entries.js";
import { searchEntries } from "./search-index.js";
import "./search-dialog.css";

const icons = { pages: "arrow", actions: "plus" };

/**
 * The ⌘K search (handoff §5.9): a combobox over grouped results (Seiten, An Agenten,
 * Aktionen), each with its path. Arrows move, Enter opens, Escape closes and returns
 * the focus to where it was. `choose(entry)` performs a result.
 */
export default function SearchDialog({
  close,
  choose,
  agents,
  agentsEnabled,
  connections,
  loading,
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef(null);
  const list = useRef(null);
  const id = useId();
  const language = getLanguage();
  const index = useMemo(
    () => buildSearchIndex({ agents, connections, agentsEnabled }),
    [agents, connections, agentsEnabled],
  );
  const groups = useMemo(() => searchEntries(index, query), [index, query]);
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
  // closing a phone drawer behind the search (one layer per press).
  useEffect(() => {
    const escape = (event) => {
      if (event.key === "Escape") event.stopPropagation();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, []);
  const move = (step) => {
    if (!items.length) return;
    setActive((current + step + items.length) % items.length);
  };
  const onKeyDown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (items[current]) choose(items[current]);
    }
  };
  const text = (value) => value?.[language] ?? value?.de ?? "";
  let position = -1;
  return (
    <Modal title={copy.title} close={close} className="search-dialog" dismissOnBackdrop>
      <div className="search-field">
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
          aria-label={copy.inputLabel}
          aria-expanded={items.length > 0}
          aria-controls={`${id}-results`}
          aria-autocomplete="list"
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          placeholder={copy.placeholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <span className="search-count" role="status">
          {query.trim() ? copy.matches(items.length) : ""}
        </span>
      </div>
      <div
        ref={list}
        id={`${id}-results`}
        role="listbox"
        aria-label={copy.resultsLabel}
        className="search-results"
      >
        {groups.map((group) => (
          <div
            key={group.group}
            role="group"
            aria-labelledby={`${id}-${group.group}`}
            className="search-group"
          >
            <div id={`${id}-${group.group}`} className="search-group-label">
              {copy.groups[group.group]}
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
                  className={selected ? "search-option active" : "search-option"}
                  onMouseMove={() => !selected && setActive(at)}
                  // The field keeps the focus, so typing continues after a tap.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(item)}
                >
                  <span className="search-option-icon" aria-hidden="true">
                    {group.group === "agents" ? (
                      text(item.label).trim().charAt(0).toUpperCase()
                    ) : (
                      <Icon name={icons[group.group]} size={14} />
                    )}
                  </span>
                  <span className="search-option-text">
                    <span className="search-option-label">{text(item.label)}</span>
                    <span className="search-option-path">
                      {text(item.path)}
                      {item.alias ? ` · ${copy.formerly(text(item.alias))}` : ""}
                    </span>
                  </span>
                  {selected && (
                    <span className="search-option-key" aria-hidden="true">
                      ↵
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {!items.length && (
        <div className="search-empty">
          <p className="search-empty-title">{copy.noResults(query.trim())}</p>
          <p>{copy.noResultsHint}</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setQuery("");
              input.current?.focus();
            }}
          >
            {copy.reset}
          </button>
        </div>
      )}
      {loading && (
        <p className="search-loading" role="status">
          {copy.loadingConnections}
        </p>
      )}
      <div className="search-keys" aria-hidden="true">
        <span>{copy.keySelect}</span>
        <span>{copy.keyOpen}</span>
        <span>{copy.keyOldNames}</span>
      </div>
    </Modal>
  );
}
