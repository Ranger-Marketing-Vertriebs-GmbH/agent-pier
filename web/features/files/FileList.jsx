import React from "react";
import Icon from "../../components/Icon.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";

function size(value) {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

export default function FileList({ listing, selected, onOpen, onProperties, onPage }) {
  return (
    <section className="explorer-list" aria-label={copy.fileList}>
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
        >
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
        </div>
      ))}
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
