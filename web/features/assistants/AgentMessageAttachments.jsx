import React from "react";
import Icon from "../../components/Icon.jsx";
import "./agent-attachments.css";
import { assistantAttachmentsCopy as copy } from "../../lib/i18n/messages/assistant-attachments.js";
import { formatNumber } from "../../lib/i18n/index.js";

export function fileSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  const megabytes = bytes >= 1024 * 1024;
  const value = bytes / (megabytes ? 1024 * 1024 : 1024);
  return `${formatNumber(value, { maximumFractionDigits: 1 })} ${megabytes ? "MB" : "KB"}`;
}

const source = (id) => `/api/assistant-attachments/${encodeURIComponent(id)}`;
// HEIC stays a download: most browsers cannot show it.
const shown = (file) => file.kind === "image" && file.type !== "image/heic";

// The owner's files in a sent message: thumbnails that open the image, and chips
// that download the file. Both are served through the signed-in route by id.
export default function AgentMessageAttachments({ files }) {
  if (!files?.length) return null;
  return (
    <ul className="agent-message-attachments" aria-label={copy.sent}>
      {files.map((file) =>
        shown(file) ? (
          <li key={file.id} className="agent-message-image">
            <a
              href={source(file.id)}
              target="_blank"
              rel="noreferrer"
              aria-label={copy.open(file.name)}
            >
              <img src={source(file.id)} alt={file.name} loading="lazy" />
            </a>
          </li>
        ) : (
          <li key={file.id} className="agent-attachment-chip ready">
            <span className="agent-attachment-icon" aria-hidden="true">
              <Icon name="file" size={16} />
            </span>
            <a
              className="agent-attachment-text"
              href={source(file.id)}
              download={file.name}
              aria-label={copy.download(file.name)}
            >
              <span className="agent-attachment-name">{file.name}</span>
              <span className="agent-attachment-meta">{fileSize(file.size)}</span>
            </a>
          </li>
        ),
      )}
    </ul>
  );
}
