import React from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import useAssistants from "./useAssistants.js";
import { avatarGlyph } from "./avatar-glyph.js";
import { connectionMissing } from "./connection-state.js";
export default function AssistantHeader({
  assistant,
  view,
  navigate,
  onChat,
  state,
  label,
}) {
  const { runtime, models } = useAssistants();
  const missing = connectionMissing(assistant, models);
  const status = missing ? "connectionMissing" : state || runtime.availability;
  const settings = () =>
    navigate({ view: "agents", assistantId: assistant.id, agentSettings: true });
  return (
    <div className="assistant-profile-header">
      <div className="assistant-breadcrumb">
        <button type="button" onClick={() => navigate({ view: "agents" })}>
          {copy.title}
        </button>
        <span aria-hidden="true">›</span>
        <span>{assistant.name}</span>
      </div>
      <header className="assistant-chat-header">
        <span className="assistant-avatar" aria-hidden="true">
          {avatarGlyph(assistant.name)}
        </span>
        <div className="assistant-profile-title">
          <div className="assistant-title-line">
            <h1>{assistant.name}</h1>
            <span className={`assistant-state-badge ${status}`}>
              {missing ? copy.status[status] : label || copy.status[status]}
            </span>
          </div>
          <p className="assistant-note">{assistant.model.modelId}</p>
        </div>
        <button
          type="button"
          className="button secondary"
          onClick={view === "conversation" ? settings : onChat}
        >
          {view === "conversation" ? copy.settings : copy.chat}
        </button>
      </header>
      {missing && (
        <p role="status" className="assistant-notice">
          {copy.connectionMissingHint}
        </p>
      )}
      <nav className="assistant-view-tabs" aria-label={copy.navigation}>
        <button
          type="button"
          aria-current={view === "conversation" ? "page" : undefined}
          onClick={onChat}
        >
          {copy.conversation}
        </button>
        <button
          type="button"
          aria-current={view === "settings" ? "page" : undefined}
          onClick={settings}
        >
          {copy.settingsTab}
        </button>
      </nav>
    </div>
  );
}
