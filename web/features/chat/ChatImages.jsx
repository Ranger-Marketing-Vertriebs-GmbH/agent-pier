import { commonCopy } from "../../lib/i18n/messages/common.js";
import { chatImagesCopy as copy } from "../../lib/i18n/messages/chat.js";
import React, { useEffect, useRef, useState } from "react";
function imageURL(sessionId, id) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/chat/images/${id}`;
}
function FullImage({ image, sessionId, close }) {
  const dialog = useRef(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const node = dialog.current;
    node.showModal();
    return () => node.close();
  }, []);
  return (
    <dialog
      className="chat-image-dialog"
      ref={dialog}
      aria-label={copy.chatImageDialogAriaLabel}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="chat-image-dialog-content">
        <header>
          <span>{copy.chatImageDialogAriaLabel}</span>
          <button
            type="button"
            aria-label={copy.chatImageDialogContentAriaLabel}
            onClick={close}
          >
            ×
          </button>
        </header>
        {failed ? (
          <p className="chat-image-unavailable" role="status">
            {copy.missingImage}
          </p>
        ) : (
          <img
            src={imageURL(sessionId, image.id)}
            alt={commonCopy.imageTitle(image.path)}
            onError={() => setFailed(true)}
          />
        )}
        <code className="chat-image-path">{image.path}</code>
      </div>
    </dialog>
  );
}
function Thumbnail({ image, sessionId, open }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const url = imageURL(sessionId, image.id) + (attempt ? `?retry=${attempt}` : "");
  return (
    <figure className="chat-image-card">
      <button
        className={`chat-image-open${failed ? " chat-image-open-failed" : ""}`}
        type="button"
        aria-label={copy.chatImageOpenAriaLabel(image.path)}
        disabled={!loaded || failed}
        onClick={() => open(image)}
      >
        {failed ? (
          <span className="chat-image-unavailable">
            {copy.unavailableImage}
            <br />
            <small>{copy.chatImageUnavailableHint}</small>
          </span>
        ) : (
          <img
            key={attempt}
            src={url}
            loading="lazy"
            decoding="async"
            alt={commonCopy.imagePreviewTitle(image.path)}
            onLoad={() => setLoaded(true)}
            onError={() => {
              setFailed(true);
              setLoaded(false);
            }}
          />
        )}
        {loaded && !failed && (
          <span className="chat-image-expand" aria-hidden="true">
            {copy.chatImageExpand}
          </span>
        )}
      </button>
      <figcaption>
        <code className="chat-image-path">{image.path}</code>
        {failed && (
          <button
            className="chat-image-retry"
            type="button"
            onClick={() => {
              setAttempt((value) => value + 1);
              setFailed(false);
            }}
          >
            {copy.chatImageRetry}
          </button>
        )}
      </figcaption>
    </figure>
  );
}
export default function ChatImages({ images = [], sessionId }) {
  const [selected, setSelected] = useState(null);
  const visible = images
    .filter(
      (image) =>
        image && /^[a-f0-9]{64}$/.test(image.id) && typeof image.path === "string",
    )
    .slice(0, 8);
  if (!visible.length) return null;
  return (
    <>
      <div className="chat-images" aria-label={copy.chatImagesAriaLabel}>
        {visible.map((image) => (
          <Thumbnail
            key={image.id}
            image={image}
            sessionId={sessionId}
            open={setSelected}
          />
        ))}
      </div>
      {selected && (
        <FullImage
          key={selected.id}
          image={selected}
          sessionId={sessionId}
          close={() => setSelected(null)}
        />
      )}
    </>
  );
}
