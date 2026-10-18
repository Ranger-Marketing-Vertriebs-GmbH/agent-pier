import React from "react";
import Icon from "../../components/Icon.jsx";
import "./agent-attachments.css";
import { assistantAttachmentsCopy as copy } from "../../lib/i18n/messages/assistant-attachments.js";
import { fileSize } from "./AgentMessageAttachments.jsx";

// The files picked for the next message, above the text field: a thumbnail or a
// file chip each, with upload progress, its error and a remove button.
export default function AgentAttachmentTray({ attachments }) {
  const { items, error, imageInput, remove } = attachments;
  if (!items.length && !error) return null;
  return (
    <div className="agent-attachments">
      {items.length > 0 && (
        <ul className="agent-attachment-list" aria-label={copy.list}>
          {items.map((item) => (
            <li key={item.key} className={`agent-attachment-chip ${item.status}`}>
              {item.previewUrl ? (
                <img src={item.previewUrl} alt="" />
              ) : (
                <span className="agent-attachment-icon" aria-hidden="true">
                  <Icon name={item.video ? "video" : "file"} size={16} />
                </span>
              )}
              <span className="agent-attachment-text">
                <span className="agent-attachment-name">{item.name}</span>
                <span
                  className="agent-attachment-meta"
                  role={item.status === "failed" ? "alert" : undefined}
                >
                  {item.status === "uploading"
                    ? item.progress > 0
                      ? copy.uploadingProgress(item.progress)
                      : copy.uploading
                    : item.status === "failed"
                      ? item.error
                      : fileSize(item.size)}
                </span>
              </span>
              <button
                type="button"
                className="agent-attachment-remove"
                aria-label={copy.remove(item.name)}
                onClick={() => remove(item.key)}
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {imageInput === false && items.some((item) => item.image) && (
        <p className="agent-attachments-note" role="status">
          {copy.noImageInput}
        </p>
      )}
      {error && (
        <p className="agent-attachments-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
