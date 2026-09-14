import React, { useState } from "react";
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
  const menuEntry = listing.entries.find(
    (entry) => entry.path === menu?.path && entry.revision === menu?.revision,
  );
  const selectedItems = (entry) =>
    selection?.selected.some((item) => item.path === entry.path)
      ? selection.selected
      : [entry];
  const openMenu = (entry) => {
    setMenu(entry);
  };
  const act = (kind) => {
    onAction(kind, selectedItems(menuEntry));
    setMenu(null);
  };
  return (
    <section
      className="explorer-list"
      aria-label={copy.fileList}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setMenu(null);
          selection?.clear();
        }
        if (event.target.closest("input:not([type=checkbox]),textarea")) return;
        const key = event.key.toLowerCase();
        if ((event.metaKey || event.ctrlKey) && ["c", "x", "v"].includes(key)) {
          event.preventDefault();
          onAction({ c: "copy", x: "cut", v: "paste" }[key], selection.selected);
        } else if (event.key === "Delete" && selection.selected.length) {
          event.preventDefault();
          onAction("trash", selection.selected);
        } else if (event.key === "F2" && selection.selected.length === 1) {
          event.preventDefault();
          onAction("rename", selection.selected);
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
            openMenu(entry);
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
              onClick={() => openMenu(entry)}
            >
              <Icon name="menu" />
            </button>
          )}
        </div>
      ))}
      {menuEntry && (
        <div
          role="menu"
          aria-label={copy.actions.menu(menuEntry.name)}
          className="file-context-menu"
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
          <button role="menuitem" onClick={() => setMenu(null)}>
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
