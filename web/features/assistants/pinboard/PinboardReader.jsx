import React, { useCallback, useEffect, useRef, useState } from "react";
import ChatMarkdown from "../../../components/ChatMarkdown.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import FileLink from "../../../components/FileLink.jsx";
import Icon from "../../../components/Icon.jsx";
import ImageViewer from "../../../components/ImageViewer.jsx";
import { agentPinboardCopy as copy } from "../../../lib/i18n/messages/agent-pinboard.js";
import { assistantAttachmentsCopy as attachmentCopy } from "../../../lib/i18n/messages/assistant-attachments.js";
import { fileSize } from "../AgentMessageAttachments.jsx";
import { MARKDOWN_PREVIEW_MAX_BYTES } from "../agent-markdown-preview.js";
import useMarkdownFile from "../useMarkdownFile.js";
import { pinboardFileUrl } from "./pinboard-api.js";
import { neighbours, readable } from "./pinboard-view.js";
import "./pinboard-reader.css";

function DownloadLink({ entry, src }) {
  return (
    <FileLink
      className="button primary"
      href={`${src}?download=1`}
      name={entry.name}
      aria-label={attachmentCopy.download(entry.name)}
    >
      {copy.reader.download}
    </FileLink>
  );
}

// Markdown through ChatMarkdown, as in the chat's preview: no raw HTML, no remote
// images. Seen once the text is read (or known to be too large to show).
function TextBody({ entry, src, loaded }) {
  const state = useMarkdownFile(src, entry);
  const done = Boolean(state.text !== undefined || state.tooLarge);
  useEffect(() => {
    if (done) loaded();
  }, [done, loaded]);
  if (state.loading)
    return (
      <p className="loading" role="status">
        {attachmentCopy.previewLoading}
      </p>
    );
  if (state.failed) return <ErrorMessage error={attachmentCopy.previewFailed} />;
  if (state.tooLarge)
    return (
      <>
        <p className="agent-markdown-notice" role="status">
          {attachmentCopy.previewTooLarge(fileSize(MARKDOWN_PREVIEW_MAX_BYTES))}
        </p>
        <DownloadLink entry={entry} src={src} />
      </>
    );
  return (
    <div className="message-content agent-markdown-preview">
      <ChatMarkdown>{state.text}</ChatMarkdown>
    </div>
  );
}

function ImageBody({ entry, src, loaded }) {
  const [viewer, setViewer] = useState(null);
  return (
    <>
      <button
        type="button"
        className="pinboard-reader-image"
        aria-label={attachmentCopy.open(entry.name)}
        onClick={(event) => setViewer(event.currentTarget)}
      >
        <img src={src} alt={entry.name} onLoad={loaded} />
      </button>
      {viewer && (
        <ImageViewer
          src={src}
          alt={entry.name}
          title={entry.name}
          name={entry.name}
          opener={viewer}
          close={() => setViewer(null)}
        />
      )}
    </>
  );
}

// Metadata is enough to count a player as loaded: Chrome does not decode a frame
// for preload="metadata", Safari does after the #t fragment.
function PlayerBody({ entry, src, loaded }) {
  const Tag = entry.kind === "video" ? "video" : "audio";
  return (
    <Tag
      className="pinboard-reader-player"
      controls
      playsInline={entry.kind === "video" ? true : undefined}
      preload="metadata"
      src={entry.kind === "video" ? `${src}#t=0.001` : src}
      aria-label={
        entry.kind === "video"
          ? attachmentCopy.video(entry.name)
          : attachmentCopy.audio(entry.name)
      }
      onLoadedData={loaded}
      onLoadedMetadata={loaded}
    />
  );
}

function FileBody({ entry, src, loaded }) {
  useEffect(() => {
    loaded();
  }, [loaded]);
  return <DownloadLink entry={entry} src={src} />;
}

const bodies = { text: TextBody, image: ImageBody, video: PlayerBody, audio: PlayerBody };

function Step({ entry, direction, onNavigate }) {
  const label = direction === "previous" ? copy.reader.previous : copy.reader.next;
  return (
    <button
      type="button"
      className={`button secondary pinboard-reader-step ${direction}`}
      disabled={!entry}
      onClick={() => entry && onNavigate(entry.id)}
    >
      {direction === "previous" && <Icon name="back" size={16} />}
      <span className="pinboard-reader-step-text">
        <span>{label}</span>
        {entry && <span className="pinboard-reader-step-name">{entry.name}</span>}
      </span>
      {direction === "next" && <Icon name="arrow" size={16} />}
    </button>
  );
}

/**
 * One pinned file read in full, with previous / next through the list's readable
 * entries (an unavailable one is skipped). `markSeen(entryId)` runs once per entry,
 * when its file has loaded. Fills the pinboard area; the entry's own state resets when
 * `entryId` changes.
 */
export default function PinboardReader({
  assistant,
  list,
  entryId,
  onNavigate,
  onBack,
  markSeen,
}) {
  const { previous, next, index, total } = neighbours(list, entryId);
  const entry = index >= 0 ? readable(list)[index] : null;
  const marked = useRef(new Set());
  const [loadedId, setLoadedId] = useState(null);
  const loaded = useCallback(() => setLoadedId(entryId), [entryId]);
  useEffect(() => {
    if (loadedId !== entryId || marked.current.has(entryId)) return;
    marked.current.add(entryId);
    Promise.resolve(markSeen(entryId)).catch(() => {
      // A failed mark leaves NEW on; opening the entry again tries once more.
      marked.current.delete(entryId);
    });
  }, [loadedId, entryId, markSeen]);
  const Body = entry ? bodies[entry.kind] || FileBody : null;
  const src = entry ? pinboardFileUrl(assistant.id, entry.id) : "";
  return (
    <div className="pinboard-reader">
      <header className="pinboard-reader-header">
        <button
          type="button"
          className="icon-button"
          aria-label={copy.reader.back}
          title={copy.reader.back}
          onClick={onBack}
        >
          <Icon name="back" size={18} />
        </button>
        <div className="pinboard-reader-titles">
          <h3>{entry?.name ?? list?.title}</h3>
          {entry && (
            <p>
              {list.title} · {copy.reader.position(index + 1, total)}
            </p>
          )}
        </div>
      </header>
      <div className="pinboard-reader-body">
        {entry ? (
          <Body key={entry.id} entry={entry} src={src} loaded={loaded} />
        ) : (
          <p className="pinboard-empty" role="status">
            {copy.reader.empty}
          </p>
        )}
      </div>
      <footer className="pinboard-reader-footer">
        <Step entry={previous} direction="previous" onNavigate={onNavigate} />
        <Step entry={next} direction="next" onNavigate={onNavigate} />
      </footer>
    </div>
  );
}
