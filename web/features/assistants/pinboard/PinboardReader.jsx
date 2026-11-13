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
import { pinboardApi, pinboardFileUrl } from "./pinboard-api.js";
import { neighbours } from "./pinboard-view.js";
import "./pinboard-reader.css";

function DownloadLink({ entry, href }) {
  return (
    <FileLink
      className="button primary"
      href={href}
      name={entry.name}
      aria-label={attachmentCopy.download(entry.name)}
    >
      {copy.reader.download}
    </FileLink>
  );
}

// Markdown through ChatMarkdown, as in the chat's preview: no raw HTML, no remote
// images. Seen once the text is read (or known to be too large to show).
function TextBody({ entry, src, download, loaded }) {
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
  if (state.failed)
    return (
      <>
        <ErrorMessage error={attachmentCopy.previewFailed} />
        <DownloadLink entry={entry} href={download} />
      </>
    );
  if (state.tooLarge)
    return (
      <>
        <p className="agent-markdown-notice" role="status">
          {attachmentCopy.previewTooLarge(fileSize(MARKDOWN_PREVIEW_MAX_BYTES))}
        </p>
        <DownloadLink entry={entry} href={download} />
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

// A pinned HTML page as the agent built it, in a frame without scripts, same origin,
// forms, popups or top navigation; the server's page policy holds besides
// (agent-pinboard-pages.js). Its links move the frame only, an image link shows the
// image; "Back to the page" opens the pinned page again under a new grant. Loaded
// with the frame.
function PageBody({ entry, assistantId, download, loaded }) {
  const [opened, setOpened] = useState(0);
  const [page, setPage] = useState({ url: null, failed: false });
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    let current = true;
    setPage({ url: null, failed: false });
    pinboardApi.page(assistantId, entry.id).then(
      (url) => current && setPage({ url, failed: false }),
      () => current && setPage({ url: null, failed: true }),
    );
    return () => {
      current = false;
    };
  }, [assistantId, entry.id, opened]);
  if (page.failed)
    return (
      <>
        <ErrorMessage error={attachmentCopy.previewFailed} />
        <DownloadLink entry={entry} href={download} />
      </>
    );
  return (
    <>
      <div className="pinboard-reader-page-bar">
        <button
          type="button"
          className="button secondary"
          disabled={loads < 2}
          onClick={() => {
            setLoads(0);
            setOpened((count) => count + 1);
          }}
        >
          <Icon name="back" size={16} />
          {copy.reader.backToPage}
        </button>
      </div>
      {page.url ? (
        <iframe
          key={page.url}
          className="pinboard-reader-page"
          src={page.url}
          sandbox=""
          referrerPolicy="no-referrer"
          title={copy.reader.page(entry.name)}
          onLoad={() => {
            setLoads((count) => count + 1);
            loaded();
          }}
        />
      ) : (
        <p className="loading" role="status">
          {attachmentCopy.previewLoading}
        </p>
      )}
    </>
  );
}

function FileBody({ entry, download, loaded }) {
  useEffect(() => {
    loaded();
  }, [loaded]);
  return <DownloadLink entry={entry} href={download} />;
}

const bodies = {
  text: TextBody,
  image: ImageBody,
  video: PlayerBody,
  audio: PlayerBody,
  page: PageBody,
};

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
 * entries (an unavailable one is skipped; the one being read stays, saying it is no
 * longer available). A file the agent rewrites while it is read shows its new
 * version. `markSeen(entryId)` runs once per NEW version, when its file has loaded.
 * Fills the pinboard area; on a phone the pinboard tab shows it full screen.
 */
export default function PinboardReader({
  assistant,
  list,
  entryId,
  onNavigate,
  onBack,
  markSeen,
}) {
  const { entry, previous, next, index, total } = neighbours(list, entryId);
  const available = entry && entry.state !== "unavailable";
  // One version of one entry: a rewrite (version + 1) loads and marks it again.
  const shown = available ? `${entry.id}:${entry.version}` : null;
  const fresh = Boolean(available && entry.fresh);
  const marked = useRef(new Set());
  const [loadedKey, setLoadedKey] = useState(null);
  const loaded = useCallback(() => setLoadedKey(shown), [shown]);
  useEffect(() => {
    if (!fresh || loadedKey !== shown || marked.current.has(shown)) return;
    marked.current.add(shown);
    Promise.resolve(markSeen(entryId)).catch(() => {
      // A failed mark leaves NEW on; opening the entry again tries once more.
      marked.current.delete(shown);
    });
  }, [fresh, loadedKey, shown, entryId, markSeen]);
  const Body = available ? bodies[entry.kind] || FileBody : null;
  const src = available
    ? pinboardFileUrl(assistant.id, entry.id, { version: entry.version })
    : "";
  const download = available
    ? pinboardFileUrl(assistant.id, entry.id, { download: true })
    : "";
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
        {available && (
          <FileLink
            className="icon-button pinboard-reader-download"
            href={download}
            name={entry.name}
            aria-label={copy.reader.download}
            title={copy.reader.download}
          >
            <Icon name="download" size={18} />
          </FileLink>
        )}
      </header>
      <div className="pinboard-reader-body">
        {available ? (
          <Body
            key={shown}
            entry={entry}
            assistantId={assistant.id}
            src={src}
            download={download}
            loaded={loaded}
          />
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
