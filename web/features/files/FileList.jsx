import React, { useEffect, useRef, useState } from "react";
import Icon from "../../components/Icon.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";
import { canExtract } from "./FileArchiveDialog.jsx";

function size(value) {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

export default function FileList({
  listing,
  selected,
  onOpen,
  onProperties,
  onPage,
  selection,
  onAction,
  readOnly,
  onDrag,
  onDrop,
}) {
  const [menu, setMenu] = useState(null);
  const menuRef = useRef(null);
  const menuOrigin = useRef(null);
  const listRef = useRef(null);
  const menuEntry = listing.entries.find(
    (entry) => entry.path === menu?.path && entry.revision === menu?.revision,
  );
  const selectedItems = (entry) =>
    selection?.selected.some((item) => item.path === entry.path)
      ? selection.selected
      : [entry];
  const closeMenu = (restore = true) => {
    setMenu(null);
    if (restore)
      queueMicrotask(() => {
        if (menuOrigin.current?.isConnected) menuOrigin.current.focus();
        else listRef.current?.querySelector("input, button")?.focus();
      });
  };
  const openMenu = (entry, origin) => {
    menuOrigin.current = origin;
    setMenu(entry);
  };
  useEffect(() => {
    if (menuEntry)
      menuRef.current?.querySelector("[role='menuitem']:not(:disabled)")?.focus();
  }, [menuEntry]);
  const act = (kind) => {
    const origin = menuOrigin.current;
    onAction(kind, selectedItems(menuEntry), origin);
    closeMenu(false);
  };
  return (
    <section
      className="explorer-list"
      ref={listRef}
      aria-label={copy.fileList}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menuEntry) {
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
        }
      }}
    >
      <div className="explorer-list-header" aria-hidden="true">
        <span>{copy.name}</span>
        <span>{copy.type}</span>
        <span>{copy.size}</span>
        <span>{copy.modified}</span>
        <span />
      </div>
      {!listing.entries.length && <p>{copy.empty}</p>}
      {listing.entries.map((entry) => (
        <div
          className={`explorer-entry ${selected === entry.path ? "selected" : ""}`}
          key={entry.path}
          draggable={!readOnly}
          onDragStart={(event) => onDrag?.(selectedItems(entry), event)}
          onDragOver={(event) => {
            if (
              entry.type === "directory" &&
              event.dataTransfer.types.includes("application/x-agentpier-files")
            ) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={(event) => {
            if (entry.type === "directory") onDrop?.(entry.path, event);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu(entry, event.currentTarget.querySelector(".explorer-entry-name"));
          }}
        >
          {selection && (
            <input
              className="file-selection-checkbox"
              type="checkbox"
              aria-label={copy.actions.select(entry.name)}
              checked={selection.selected.some((item) => item.path === entry.path)}
              onChange={(event) => {
                event.currentTarget.focus();
                return event.nativeEvent.shiftKey
                  ? selection.range(entry.path)
                  : selection.toggle(entry.path);
              }}
            />
          )}
          <button
            type="button"
            className="explorer-entry-name"
            onClick={() => onOpen(entry)}
          >
            <Icon
              name={
                entry.type === "directory"
                  ? "folder"
                  : entry.type === "symlink"
                    ? "link"
                    : "book"
              }
            />
            <span>{entry.name}</span>
          </button>
          <span>{copy.types[entry.type]}</span>
          <span>{size(entry.size)}</span>
          <time dateTime={entry.modifiedAt || undefined}>
            {entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : "—"}
          </time>
          <button
            type="button"
            className="icon-button"
            aria-label={copy.showProperties(entry.name)}
            onClick={() => onProperties(entry)}
          >
            <Icon name="info" />
          </button>
          {onAction && (
            <button
              type="button"
              className="icon-button"
              aria-label={copy.actions.menu(entry.name)}
              onClick={(event) => openMenu(entry, event.currentTarget)}
            >
              <Icon name="menu" />
            </button>
          )}
        </div>
      ))}
      {menuEntry && (
        <div
          role="menu"
          ref={menuRef}
          aria-label={copy.actions.menu(menuEntry.name)}
          className="file-context-menu"
          onKeyDown={(event) => {
            const items = [
              ...event.currentTarget.querySelectorAll("[role='menuitem']"),
            ].filter((item) => !item.disabled);
            const position = items.indexOf(document.activeElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : event.key === "ArrowDown"
                    ? (position + 1) % items.length
                    : event.key === "ArrowUp"
                      ? (position - 1 + items.length) % items.length
                      : null;
            if (next !== null) {
              event.preventDefault();
              event.stopPropagation();
              items[next]?.focus();
            }
          }}
        >
          {[
            "copy",
            "cut",
            "rename",
            "path",
            "trash",
            "archive",
            "download_zip",
            "extract_here",
            "extract_to",
          ].map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              disabled={
                (readOnly &&
                  [
                    "cut",
                    "rename",
                    "trash",
                    "archive",
                    "extract_here",
                    "extract_to",
                  ].includes(kind)) ||
                (kind === "rename" && selectedItems(menuEntry).length !== 1) ||
                (kind.startsWith("extract_") && !canExtract(selectedItems(menuEntry)))
              }
              onClick={() => act(kind)}
            >
              {kind === "path"
                ? copy.actions.copyPath
                : copy.actions[kind] || copy.transfers.actions[kind]}
            </button>
          ))}
          <button role="menuitem" onClick={() => closeMenu()}>
            {copy.actions.choices.cancel}
          </button>
        </div>
      )}
      {(listing.page > 1 || listing.hasMore) && (
        <div className="explorer-pagination">
          <button
            type="button"
            className="button secondary compact"
            disabled={listing.page === 1}
            onClick={() => onPage(listing.page - 1)}
          >
            {copy.previous}
          </button>
          <span>{copy.page(listing.page)}</span>
          <button
            type="button"
            className="button secondary compact"
            disabled={!listing.hasMore}
            onClick={() => onPage(listing.page + 1)}
          >
            {copy.next}
          </button>
        </div>
      )}
    </section>
  );
}
