import React, { lazy, Suspense, useId, useMemo, useState } from "react";
import { chatMessageCopy as copy } from "../../lib/i18n/messages/chat.js";
import { changePreview } from "./file-change-preview.js";
import { fileLanguage } from "./tool-output.js";
import ToolOutput from "./ToolOutput.jsx";
import "./tool-changes.css";
const ToolDiffCode = lazy(() => import("./ToolDiffCode.jsx"));
export default function ToolChanges({ message }) {
  const [limit, setLimit] = useState(8);
  const [raw, setRaw] = useState(false);
  const id = useId();
  const preview = useMemo(
    () => changePreview(message.fileChanges, limit),
    [message.fileChanges, limit],
  );
  return (
    <div className="tool-output tool-changes">
      <div id={id}>
        {preview.files.map((file, index) => (
          <section className="tool-change" key={`${file.path}:${index}`}>
            <div className="tool-change-heading">
              <strong>
                {file.path}
                {file.movePath && <> → {file.movePath}</>}
              </strong>
              <span>
                {
                  copy[
                    `change${file.operation[0].toUpperCase()}${file.operation.slice(1)}`
                  ]
                }
              </span>
              {file.provenance !== "preview" && file.rows.length > 0 && (
                <span className="tool-change-count">
                  +{file.added} −{file.removed}
                </span>
              )}
              <small>
                {file.provenance === "full"
                  ? copy.changeFull
                  : file.provenance === "patch"
                    ? copy.changePatch
                    : file.provenance === "preview"
                      ? copy.changePreview
                      : copy.changeExcerpt}
              </small>
            </div>
            {file.rows.length > 0 && (
              <div
                className="tool-diff-scroll"
                tabIndex={0}
                role="region"
                aria-label={copy.changeCode}
              >
                <div className="tool-diff-lines">
                  <Suspense
                    fallback={
                      <pre>
                        {file.rows
                          .map(
                            (row) =>
                              `${row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}${row.text}`,
                          )
                          .join("\n")}
                      </pre>
                    }
                  >
                    <ToolDiffCode rows={file.rows} language={fileLanguage(file.path)} />
                  </Suspense>
                </div>
              </div>
            )}
          </section>
        ))}
      </div>
      {(preview.truncated || limit > 8) && (
        <div className="tool-output-actions">
          {preview.truncated && (
            <button
              type="button"
              aria-controls={id}
              aria-expanded={limit > 8}
              onClick={() => setLimit(limit === 8 ? 200 : limit + 200)}
            >
              {limit === 8 ? copy.expandOutput : copy.moreOutput}
            </button>
          )}
          {limit > 8 && (
            <button
              type="button"
              aria-controls={id}
              aria-expanded="true"
              onClick={() => setLimit(8)}
            >
              {copy.collapseOutput}
            </button>
          )}
        </div>
      )}
      <details
        className="tool-change-raw"
        onToggle={(event) => setRaw(event.currentTarget.open)}
      >
        <summary>{copy.changeRaw}</summary>
        {raw && <ToolOutput text={message.text} toolName={message.toolName} />}
      </details>
    </div>
  );
}
