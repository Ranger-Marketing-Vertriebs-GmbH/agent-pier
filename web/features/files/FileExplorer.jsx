import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import CreateDirectory from "../directories/CreateDirectory.jsx";
import { filesCopy as copy } from "../../lib/i18n/de/files.js";
import "./files.css";

export default function FileExplorer({ session, route, navigate }) {
  const folder = route.filePath || "",
    file = route.file || "",
    page = route.filePage || 1;
  const [listing, setListing] = useState(null),
    [preview, setPreview] = useState(null),
    [error, setError] = useState(""),
    [previewError, setPreviewError] = useState("");
  const base = `/sessions/${encodeURIComponent(session.id)}/files`;
  function go(filePath, changes = {}) {
    navigate({ ...route, mode: "files", filePath, filePage: 1, file: "", ...changes });
  }
  useEffect(() => {
    const controller = new AbortController();
    setListing(null);
    setError("");
    api(
      `${base}?${new URLSearchParams({ path: folder, page: String(page) })}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setListing(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [base, folder, page]);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setPreviewError("");
    if (file)
      api(
        `${base}/content?${new URLSearchParams({ path: file })}`,
        "GET",
        undefined,
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) setPreview(result);
        })
        .catch((error) => {
          if (!controller.signal.aborted) setPreviewError(error.message);
        });
    return () => controller.abort();
  }, [base, file]);
  return (
    <section className="file-explorer" aria-label={copy.tab}>
      <div className="file-explorer-heading">
        <button type="button" className="button secondary compact" onClick={() => go("")}>
          {copy.root}
        </button>
        {folder && (
          <button
            type="button"
            className="button secondary compact"
            onClick={() => go(folder.split("/").slice(0, -1).join("/"))}
          >
            {copy.up}
          </button>
        )}
        <code>{folder || session.cwd}</code>
      </div>
      <ErrorMessage error={error} />
      <div className={`file-explorer-columns ${file ? "with-preview" : ""}`}>
        <div className="file-explorer-list">
          {!listing && !error && <p role="status">{copy.loading}</p>}
          {listing && (
            <>
              <p className="field-description">{copy.summary(listing.total, page)}</p>
              {!listing.entries.length && <p>{copy.empty}</p>}
              {listing.entries.map((entry) => (
                <button
                  type="button"
                  key={entry.path}
                  className={file === entry.path ? "selected" : ""}
                  onClick={() =>
                    entry.type === "directory"
                      ? go(entry.path)
                      : go(folder, { file: entry.path, filePage: page })
                  }
                >
                  <Icon name={entry.type === "directory" ? "folder" : "book"} />
                  <span>{entry.name}</span>
                </button>
              ))}
              {(page > 1 || listing.hasMore) && (
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="button secondary compact"
                    disabled={page === 1}
                    onClick={() => go(folder, { filePage: page - 1 })}
                  >
                    {copy.previous}
                  </button>
                  <button
                    type="button"
                    className="button secondary compact"
                    disabled={!listing.hasMore}
                    onClick={() => go(folder, { filePage: page + 1 })}
                  >
                    {copy.next}
                  </button>
                </div>
              )}
              {!session.pipeline?.headless && (
                <CreateDirectory
                  key={folder}
                  create={(name) => api(base, "POST", { path: folder, name })}
                  created={(path) => go(path)}
                />
              )}
            </>
          )}
        </div>
        {file && (
          <div className="file-preview" aria-label={copy.preview}>
            <div className="file-preview-heading">
              <code>{file}</code>
              <button
                type="button"
                className="icon-button"
                aria-label={copy.close}
                onClick={() => go(folder, { filePage: page })}
              >
                <Icon name="close" />
              </button>
            </div>
            <ErrorMessage error={previewError} />
            {!preview && !previewError && <p>{copy.loading}</p>}
            {preview?.type === "text" && <pre>{preview.text}</pre>}
            {preview?.type === "image" && <img src={preview.source} alt={file} />}
          </div>
        )}
      </div>
    </section>
  );
}
