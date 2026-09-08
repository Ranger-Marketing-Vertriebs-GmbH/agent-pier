import React from "react";
import { terminalViewCopy as copy } from "../../lib/i18n/messages/terminal.js";
import { terminalPath } from "./useTerminalUploads.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import "./terminal-uploads.css";

export default function TerminalUploads({ uploads, paste }) {
  return (
    <div className="terminal-uploads">
      <ErrorMessage error={uploads.error} />
      {uploads.items.map((item) => (
        <div className="terminal-upload" key={item.key}>
          <span title={item.path || item.name}>{item.name}</span>
          {item.status === "uploading" && (
            <progress aria-label={copy.uploading} max="100" value={item.progress} />
          )}
          {item.status === "done" && (
            <>
              <span role="status">{copy.uploaded}</span>
              <button className="button" onClick={() => paste(terminalPath(item.path))}>
                {copy.insertPath}
              </button>
            </>
          )}
          {item.status === "failed" && (
            <>
              <ErrorMessage error={item.error} />
              <button
                className="button"
                disabled={uploads.busy}
                onClick={() => uploads.retry(item.key)}
              >
                {copy.retryUpload}
              </button>
            </>
          )}
          <button
            className="button"
            disabled={uploads.busy}
            onClick={() => uploads.remove(item.key)}
            aria-label={`${copy.dismissUpload}: ${item.name}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
