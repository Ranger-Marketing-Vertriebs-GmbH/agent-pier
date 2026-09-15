import React, { useRef, useState } from "react";
import { FileJobIssue, isFileJobActive } from "./FileJobs.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";

function value(value) {
  return value === null || value === undefined || value === "" ? "—" : value;
}

export default function FileProperties({
  entry,
  downloadHref,
  preview,
  error,
  previewError,
  previewOwner,
  loading,
  onClose,
  onOpenLink,
  sizeJob,
  sizePending,
  onSize,
}) {
  const ownerRef = useRef(null);
  const [copyResult, setCopyResult] = useState(null);
  if (
    !ownerRef.current ||
    ownerRef.current.selection !== previewOwner ||
    ownerRef.current.preview !== preview
  )
    ownerRef.current = { selection: previewOwner, preview };
  const owner = ownerRef.current;
  const copyStatus = copyResult?.owner === owner ? copyResult.status : "";
  const copyAll = async () => {
    if (preview?.type !== "text") return;
    setCopyResult({ owner, status: "copying" });
    let status;
    try {
      await navigator.clipboard.writeText(preview.text);
      status = "copied";
    } catch {
      status = "copyFailed";
    }
    setCopyResult((current) =>
      current?.owner === owner && ownerRef.current === owner
        ? { owner, status }
        : current,
    );
  };

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
            <dd>
              {entry.type !== "directory"
                ? value(entry.size)
                : sizeJob?.status === "completed" &&
                    !sizeJob.issue &&
                    sizeJob.totalBytes !== null
                  ? copy.measuredSize(sizeJob.totalBytes)
                  : sizeJob && !isFileJobActive(sizeJob)
                    ? copy.partialSize(sizeJob.completedBytes)
                    : sizePending || isFileJobActive(sizeJob)
                      ? copy.sizePending
                      : copy.sizeUnknown}
            </dd>
            <dt>{copy.modified}</dt>
            <dd>{value(entry.modifiedAt)}</dd>
            <dt>{copy.permissions}</dt>
            <dd>{entry.mode.toString(8).slice(-4)}</dd>
            <dt>{copy.linkTarget}</dt>
            <dd>{value(entry.linkTarget)}</dd>
          </dl>
          {downloadHref && (
            <a className="button secondary compact" href={downloadHref} download>
              {copy.downloadFile}
            </a>
          )}
          {entry.type === "directory" && (
            <>
              <button
                type="button"
                className="button secondary"
                disabled={sizePending || isFileJobActive(sizeJob)}
                onClick={onSize}
              >
                {copy.calculateSize}
              </button>
              <FileJobIssue issue={sizeJob?.issue} />
            </>
          )}
          {entry.type === "symlink" && (
            <button type="button" className="button secondary" onClick={onOpenLink}>
              {copy.openLink}
            </button>
          )}
          <ErrorMessage error={previewError?.message} />
          {preview?.type === "text" && (
            <div className="file-preview" aria-label={copy.preview}>
              <div className="file-preview-heading">
                <code>{entry.path}</code>
                <div className="file-preview-actions">
                  <button
                    type="button"
                    className="button secondary compact"
                    disabled={copyStatus === "copying"}
                    onClick={copyAll}
                  >
                    {copy.copyAll}
                  </button>
                </div>
              </div>
              {copyStatus === "copied" && <p role="status">{copy.copied}</p>}
              <ErrorMessage error={copyStatus === "copyFailed" ? copy.copyFailed : ""} />
              <pre>{preview.text}</pre>
            </div>
          )}
          {preview?.type === "image" && (
            <div className="file-preview" aria-label={copy.preview}>
              <div className="file-preview-heading">
                <code>{entry.path}</code>
              </div>
              <img src={preview.source} alt={entry.path} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
