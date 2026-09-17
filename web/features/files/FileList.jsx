import React, { useEffect, useRef, useState } from "react";
import Icon from "../../components/Icon.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";
import { actionLayoutCopy as layoutCopy } from "../../lib/i18n/messages/action-layout.js";
import { canExtract } from "./FileArchiveDialog.jsx";

function size(value) {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function modified(value) {
  return value ? new Date(value).toLocaleString() : "—";
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
    const bounds = origin.getBoundingClientRect();
    const top = Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - 430));
    setMenu({
      ...entry,
      top,
      left: Math.max(8, Math.min(bounds.right - 224, window.innerWidth - 232)),
      maxHeight: Math.max(0, window.innerHeight - top - 8),
    });
  };
  useEffect(() => {
    if (menuEntry)
      menuRef.current?.querySelector("[role='menuitem']:not(:disabled)")?.focus();
  }, [menuEntry]);
  useEffect(() => {
    if (!menuEntry) return undefined;
    const outside = (event) => {
      if (!menuRef.current?.contains(event.target)) closeMenu(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menuEntry]);
  const act = (kind) => {
    if (kind === "properties") {
      onProperties(menuEntry, menuOrigin.current);
      closeMenu(false);
      return;
    }
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
        <span className="explorer-header-name">{copy.name}</span>
        <span className="explorer-header-modified">{copy.modified}</span>
        <span className="explorer-header-size">{copy.size}</span>
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
            const origin = event.currentTarget.querySelector(".explorer-entry-name");
            const top = Math.max(8, Math.min(event.clientY, window.innerHeight - 430));
            menuOrigin.current = origin;
            setMenu({
              ...entry,
              top,
              left: Math.max(8, Math.min(event.clientX, window.innerWidth - 232)),
              maxHeight: Math.max(0, window.innerHeight - top - 8),
            });
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
            onClick={(event) => onOpen(entry, event.currentTarget)}
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
          <span className="explorer-entry-mobile-meta">
            {layoutCopy.metadata(
              copy.types[entry.type],
              size(entry.size),
              modified(entry.modifiedAt),
            )}
          </span>
          <time
            className="explorer-entry-modified"
            dateTime={entry.modifiedAt || undefined}
          >
            {modified(entry.modifiedAt)}
          </time>
          <span className="explorer-entry-size">{size(entry.size)}</span>
          <button
            type="button"
            className="icon-button explorer-entry-properties"
            aria-label={copy.showProperties(entry.name)}
            onClick={(event) => onProperties(entry, event.currentTarget)}
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
          style={{ top: menu.top, left: menu.left, maxHeight: menu.maxHeight }}
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
            !readOnly && "cut",
            !readOnly && selectedItems(menuEntry).length === 1 && "rename",
            "path",
            "properties",
            !readOnly && "trash",
            !readOnly && "archive",
            "download_zip",
            !readOnly && canExtract(selectedItems(menuEntry)) && "extract_here",
            !readOnly && canExtract(selectedItems(menuEntry)) && "extract_to",
          ]
            .filter(Boolean)
            .map((kind) => (
              <button key={kind} type="button" role="menuitem" onClick={() => act(kind)}>
                {kind === "path"
                  ? copy.actions.copyPath
                  : kind === "properties"
                    ? layoutCopy.properties
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
