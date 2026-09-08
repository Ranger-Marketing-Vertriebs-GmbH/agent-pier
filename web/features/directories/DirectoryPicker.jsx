import CreateDirectory from "./CreateDirectory.jsx";
import { commonCopy } from "../../lib/i18n/de/common.js";
import { directoryPickerCopy as copy } from "../../lib/i18n/de/directories.js";
import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import Icon from "../../components/Icon.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
export default function DirectoryPicker({ initialPath, choose, cancel }) {
  const [path, setPath] = useState(initialPath),
    [listing, setListing] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setError("");
    setListing(null);
    api(`/directories?path=${encodeURIComponent(path)}`)
      .then((data) => {
        if (alive) setListing(data);
      })
      .catch((err) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [path]);
  return (
    <div className="directory-picker">
      <p className="field-description">{copy.directorySelectionDescription}</p>
      <div className="directory-path">
        <Icon name="folder" />
        <code>{path}</code>
      </div>
      <ErrorMessage error={error} />
      <div className="directory-list">
        {listing?.parent && (
          <button type="button" onClick={() => setPath(listing.parent)}>
            <span>↰</span>
            {copy.directoryListButton}
          </button>
        )}
        {listing?.entries.map((entry) => (
          <button type="button" key={entry.path} onClick={() => setPath(entry.path)}>
            <Icon name="folder" />
            {entry.name}
            <Icon name="chevron" />
          </button>
        ))}
        {listing && !listing.entries.length && <p>{copy.directoryListDescription}</p>}
      </div>
      <CreateDirectory
        disabled={!listing}
        create={(name) => api("/directories", "POST", { path: listing.path, name })}
        created={setPath}
      />
      <div className="dialog-actions">
        <button type="button" className="button secondary" onClick={cancel}>
          {commonCopy.back}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!listing || Boolean(error)}
          onClick={() => choose(listing.path)}
        >
          {copy.useDirectory}
        </button>
      </div>
    </div>
  );
}
