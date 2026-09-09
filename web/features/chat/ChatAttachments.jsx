import Icon from "../../components/Icon.jsx";
import { chatAttachmentsCopy as copy } from "../../lib/i18n/messages/chat.js";
import { chatUploadsCopy as uploadsCopy } from "../../lib/i18n/messages/chat-uploads.js";
import React, { useRef } from "react";

export default function ChatAttachments({
  attachments,
  pending = [],
  retry,
  add,
  remove,
  uploading,
  loading,
  supported,
  disabled,
  error,
}) {
  const picker = useRef(null);
  if (!supported)
    return (
      <p className="chat-attachments-notice" title={copy.unsupportedSession}>
        {copy.unsupportedSession}
      </p>
    );
  return (
    <div className="chat-attachments">
      {attachments.length + pending.length > 0 && (
        <ul className="chat-attachment-list" aria-label={copy.listAriaLabel}>
          {attachments.map((item) => (
            <li key={item.key} className="chat-attachment-chip">
              {item.previewUrl && <img src={item.previewUrl} alt="" />}
              <span className="chat-attachment-name">{item.name}</span>
              <button
                type="button"
                disabled={disabled || uploading || loading}
                aria-label={copy.removeAriaLabel(item.name)}
                onClick={() => remove(item.key)}
              >
                ×
              </button>
            </li>
          ))}
          {pending
            .filter(
              (item) =>
                item.status === "failed" ||
                !attachments.some((attachment) => attachment.path === item.receipt?.path),
            )
            .map((item) => (
              <li key={item.key} className="chat-attachment-chip chat-upload-pending">
                <div className="chat-upload-details">
                  <span className="chat-attachment-name">{item.name}</span>
                  {item.status === "uploading" ? (
                    <>
                      <progress
                        max="100"
                        value={item.progress || 0}
                        aria-label={item.name}
                      />
                      <span role="status">
                        {item.progress === 100
                          ? uploadsCopy.finishing
                          : uploadsCopy.progress(item.progress || 0)}
                      </span>
                    </>
                  ) : (
                    <span role={item.error ? "alert" : "status"}>
                      {item.error || uploadsCopy.waiting}
                    </span>
                  )}
                </div>
                {item.status === "failed" && (
                  <button
                    type="button"
                    disabled={disabled || uploading || loading}
                    aria-label={uploadsCopy.retry(item.name)}
                    onClick={() => retry(item.key)}
                  >
                    {uploadsCopy.retryButton}
                  </button>
                )}
                <button
                  type="button"
                  disabled={disabled || uploading || loading}
                  aria-label={copy.removeAriaLabel(item.name)}
                  onClick={() => remove(item.key)}
                >
                  ×
                </button>
              </li>
            ))}
        </ul>
      )}
      <button
        type="button"
        className="button chat-attachment-add"
        aria-label={copy.attachAriaLabel}
        disabled={disabled || uploading || loading}
        onClick={() => picker.current?.click()}
      >
        <Icon name="plus" size={16} />
        <span>{uploading ? copy.uploading : copy.attachButton}</span>
      </button>
      <input
        ref={picker}
        type="file"
        aria-label={copy.choose}
        disabled={disabled || uploading || loading}
        multiple
        hidden
        onChange={(event) => {
          add(event.target.files);
          event.target.value = "";
        }}
      />
      {error && (
        <p className="chat-attachments-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
