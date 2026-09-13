import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";

function value(value) {
  return value === null || value === undefined || value === "" ? "—" : value;
}

export default function FileProperties({
  entry,
  preview,
  error,
  previewError,
  loading,
  onClose,
  onOpenLink,
}) {
  return (
    <section className="file-properties" aria-label={copy.properties}>
      <header>
        <h2>{copy.properties}</h2>
        {entry && (
          <button type="button" className="button secondary compact" onClick={onClose}>
            {copy.close}
          </button>
        )}
      </header>
      {!entry && !loading && <p>{copy.selectForProperties}</p>}
      {loading && <p role="status">{copy.loadingProperties}</p>}
      <ErrorMessage error={error?.message} />
      {entry && (
        <>
          <dl>
            <dt>{copy.name}</dt>
            <dd>{entry.name}</dd>
            <dt>{copy.path}</dt>
            <dd>{entry.path}</dd>
            <dt>{copy.type}</dt>
            <dd>{copy.types[entry.type]}</dd>
            <dt>{copy.size}</dt>
            <dd>{value(entry.size)}</dd>
            <dt>{copy.modified}</dt>
            <dd>{value(entry.modifiedAt)}</dd>
            <dt>{copy.permissions}</dt>
            <dd>{entry.mode.toString(8).slice(-4)}</dd>
            <dt>{copy.linkTarget}</dt>
            <dd>{value(entry.linkTarget)}</dd>
          </dl>
          {entry.type === "symlink" && (
            <button type="button" className="button secondary" onClick={onOpenLink}>
              {copy.openLink}
            </button>
          )}
          <ErrorMessage error={previewError?.message} />
          {preview?.type === "text" && (
            <div className="file-preview" aria-label={copy.preview}>
              <pre>{preview.text}</pre>
            </div>
          )}
          {preview?.type === "image" && (
            <div className="file-preview" aria-label={copy.preview}>
              <img src={preview.source} alt={entry.path} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
