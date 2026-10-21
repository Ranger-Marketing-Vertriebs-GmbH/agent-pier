import React, { useState } from "react";
import Icon from "../../components/Icon.jsx";
import ImageViewer from "../../components/ImageViewer.jsx";
import FileLink from "../../components/FileLink.jsx";
import "./agent-attachments.css";
import { useAgentPaths } from "./agent-paths.js";
import { assistantAttachmentsCopy as copy } from "../../lib/i18n/messages/assistant-attachments.js";
import { formatNumber } from "../../lib/i18n/index.js";

export function fileSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  if (bytes >= 1024 ** 3)
    return `${formatNumber(bytes / 1024 ** 3, { maximumFractionDigits: 1 })} GB`;
  const megabytes = bytes >= 1024 * 1024;
  const value = bytes / (megabytes ? 1024 * 1024 : 1024);
  return `${formatNumber(value, { maximumFractionDigits: 1 })} ${megabytes ? "MB" : "KB"}`;
}

// Served through the signed-in route of the owner or of the user whose app shows it.
const useSource = () => {
  const paths = useAgentPaths();
  return (id) => `/api${paths.attachment(id)}`;
};

// The name, its details and an explicit download button under a player or in a
// chip. FileLink keeps a home-screen app (iOS) in place: the share sheet instead
// of navigating; native iOS players offer no download of their own.
function FileRow({ file, details }) {
  const source = useSource();
  return (
    <div className="agent-attachment-row">
      <span className="agent-attachment-text">
        <span className="agent-attachment-name">{file.name}</span>
        {details && <span className="agent-attachment-meta">{details}</span>}
      </span>
      <FileLink
        className="icon-button agent-attachment-download"
        // The whole file as a download (Content-Disposition: attachment), never a
        // range of it, also for media the players stream inline.
        href={`${source(file.id)}?download=1`}
        name={file.name}
        aria-label={copy.download(file.name)}
        title={copy.download(file.name)}
      >
        <Icon name="download" size={18} />
      </FileLink>
    </div>
  );
}

export function videoDuration(seconds) {
  if (!Number.isFinite(seconds)) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// A video (sent by the owner or shared by the agent) plays inline from the signed-in
// route, a range at a time; iOS full screen keeps its own Done button. No poster is
// extracted on the server; the media fragment makes Safari, which preloads no frame
// on its own, show the first one.
function VideoAttachment({ file }) {
  const source = useSource();
  const details = [videoDuration(file.video?.duration), fileSize(file.size)]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="agent-message-video">
      <video
        controls
        playsInline
        preload="metadata"
        src={`${source(file.id)}#t=0.001`}
        aria-label={copy.video(file.name)}
      />
      <FileRow file={file} details={details} />
    </li>
  );
}
// Audio an agent shared plays inline with the browser's own controls.
function AudioAttachment({ file }) {
  const source = useSource();
  return (
    <li className="agent-message-audio">
      <audio
        controls
        preload="metadata"
        src={source(file.id)}
        aria-label={copy.audio(file.name)}
      />
      <FileRow file={file} details={fileSize(file.size)} />
    </li>
  );
}
// HEIC stays a download: most browsers cannot show it.
const shown = (file) => file.kind === "image" && file.type !== "image/heic";

// A sent file whose copy is gone (the agent deleted it, or the owner cleared the
// agent's attachments): its name stays, without a link.
function UnavailableAttachment({ file }) {
  return (
    <li className="agent-attachment-chip unavailable">
      <span className="agent-attachment-icon" aria-hidden="true">
        <Icon name="file" size={16} />
      </span>
      <span className="agent-attachment-text">
        <span className="agent-attachment-name">{file.name}</span>
        <span className="agent-attachment-meta">{copy.unavailable}</span>
      </span>
    </li>
  );
}

// The owner's files in a sent message, or the files an agent shared (`shared`):
// thumbnails that open the image in the in-app viewer, videos and audio that play
// inline, and chips, each with a download button. Nothing navigates away: a home-screen app
// (iOS) has no way back. All are served through the signed-in route by id.
export default function AgentMessageAttachments({ files, shared = false }) {
  const [open, setOpen] = useState(null);
  const source = useSource();
  if (!files?.length) return null;
  return (
    <>
      <ul
        className="agent-message-attachments"
        aria-label={shared ? copy.shared : copy.sent}
      >
        {files.map((file) =>
          file.unavailable ? (
            <UnavailableAttachment key={file.id} file={file} />
          ) : file.kind === "video" ? (
            <VideoAttachment key={file.id} file={file} />
          ) : file.kind === "audio" ? (
            <AudioAttachment key={file.id} file={file} />
          ) : shown(file) ? (
            <li key={file.id} className="agent-message-image">
              <button
                type="button"
                className="agent-message-image-open"
                aria-label={copy.open(file.name)}
                onClick={(event) => setOpen({ file, opener: event.currentTarget })}
              >
                <img src={source(file.id)} alt={file.name} loading="lazy" />
              </button>
            </li>
          ) : (
            <li key={file.id} className="agent-attachment-chip ready">
              <span className="agent-attachment-icon" aria-hidden="true">
                <Icon name="file" size={16} />
              </span>
              <FileRow file={file} details={fileSize(file.size)} />
            </li>
          ),
        )}
      </ul>
      {open && (
        <ImageViewer
          key={open.file.id}
          src={source(open.file.id)}
          alt={open.file.name}
          title={open.file.name}
          name={open.file.name}
          opener={open.opener}
          close={() => setOpen(null)}
        />
      )}
    </>
  );
}
