import React, { useState } from "react";
import Icon from "../../../components/Icon.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { agentChatsCopy as copy } from "../../../lib/i18n/messages/agent-chats.js";
import "./agent-chats.css";

/** The chat's title in its header; a tap opens the Chats sheet. */
export function ChatTitleButton({ title, agentName, onClick }) {
  return (
    <button
      type="button"
      className="agent-chat-title-button"
      aria-label={`${copy.showChats(agentName)}: ${title}`}
      aria-haspopup="dialog"
      onClick={onClick}
    >
      <span>{title}</span>
      <Icon name="down" size={14} />
    </button>
  );
}

/** Above an archived chat: it is read-only until restored. */
export function ArchivedChatBanner({ onRestore }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="agent-chat-banner" role="status">
      <span>{copy.archivedBanner}</span>
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await onRestore();
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {copy.restore}
      </button>
      <ErrorMessage error={error} />
    </div>
  );
}

/** In place of the composer of an archived chat. */
export function ReadOnlyComposer() {
  return <p className="agent-chat-readonly">{copy.archivedComposer}</p>;
}

/** A link to a chat that was deleted, such as a push notice's. */
export function DeletedChat({ onMain }) {
  return (
    <div className="agent-chat-deleted">
      <p>{copy.deleted}</p>
      {onMain && (
        <button type="button" className="button secondary" onClick={onMain}>
          {copy.toMain}
        </button>
      )}
    </div>
  );
}
