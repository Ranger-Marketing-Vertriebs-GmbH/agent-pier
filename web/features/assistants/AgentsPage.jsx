import AssistantHeader from "./AssistantHeader.jsx";
import { avatarGlyph } from "./avatar-glyph.js";
import React, { useEffect, useRef, useState } from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useAssistants from "./useAssistants.js";
import { assistantApi } from "./assistant-api.js";
import AssistantSettings from "./AssistantSettings.jsx";
import AssistantChat from "./AssistantChat.jsx";
import { connectionMissing } from "./connection-state.js";
export default function AgentsPage({ route, navigate }) {
  const {
    assistants,
    teams = [],
    models = [],
    runtime,
    error: loadError,
    refresh,
  } = useAssistants();
  const [creating, setCreating] = useState(false),
    [error, setError] = useState("");
  const assistant = assistants.find((a) => a.id === route.assistantId);
  const request = useRef(null);
  useEffect(
    () => () => {
      request.current = null;
    },
    [route],
  );
  async function open(a) {
    const ticket = {};
    request.current = ticket;
    setError("");
    // Without its connection the agent cannot start; the owner chooses another.
    if (connectionMissing(a, models)) {
      setError(copy.connectionMissingHint);
      return;
    }
    try {
      const c = await assistantApi.open(a.id);
      await refresh();
      if (request.current === ticket)
        navigate({ view: "agents", assistantId: a.id, conversationId: c.id });
    } catch (e) {
      if (request.current === ticket) setError(e.message);
    }
  }
  // A team task opens in the parent chat that proposed it.
  const team =
    route.teamId &&
    teams.find((t) => t.id === route.teamId && t.parentAssistantId === route.assistantId);
  const conversationId = route.conversationId || team?.parentConversationId;
  if (conversationId && assistant)
    return (
      <AssistantChat
        key={conversationId}
        assistant={assistant}
        conversationId={conversationId}
        focusTeamId={team?.id}
        navigate={navigate}
      />
    );
  if (route.agentSettings && assistant)
    return (
      <section className="assistant-detail assistant-settings-page">
        <AssistantHeader
          assistant={assistant}
          view="settings"
          navigate={navigate}
          onChat={() => open(assistant)}
        />
        <ErrorMessage error={error || loadError} />
        <div className="assistant-settings-layout">
          <div className="assistant-settings-main">
            <AssistantSettings
              key={assistant.id}
              assistant={assistant}
              navigate={navigate}
              onSaved={() => {}}
              onCancel={() => open(assistant)}
            />
          </div>
          <aside className="assistant-runtime-card assistant-operation-summary">
            <h2>{copy.runtime}</h2>
            <p className="assistant-note">{copy.runtimeDescription}</p>
            {copy.runtimeDiagnostics[runtime.diagnostic] && (
              <p role="status" className="assistant-notice">
                {copy.runtimeDiagnostics[runtime.diagnostic]}
              </p>
            )}
            <dl>
              <div>
                <dt>{copy.serviceState}</dt>
                <dd>{copy.status[runtime.availability]}</dd>
              </div>
              <div>
                <dt>{copy.syncState}</dt>
                <dd>{copy.status[runtime.sync]}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                navigate({ view: "settings", settingsSection: "assistants" })
              }
            >
              {copy.runtimeLink}
            </button>
          </aside>
        </div>
      </section>
    );
  return (
    <div className="page assistants-page">
      <header className="assistant-heading">
        <div>
          <p className="eyebrow">{copy.title}</p>
          <h1>{route.agentSettings ? assistant?.name || copy.settings : copy.title}</h1>
          <p className="assistant-note">{copy.description}</p>
        </div>
        <button
          className="button secondary"
          onClick={() => navigate({ view: "settings", settingsSection: "assistants" })}
        >
          {copy.runtimeLink}
        </button>
      </header>
      <ErrorMessage error={error || loadError} />
      {route.agentSettings ? (
        <p>{copy.unavailable}</p>
      ) : (
        <>
          <button className="button primary" onClick={() => setCreating(true)}>
            {copy.create}
          </button>
          {creating && (
            <AssistantSettings
              navigate={navigate}
              onSaved={(a) => {
                setCreating(false);
                navigate({ view: "agents", assistantId: a.id, agentSettings: true });
              }}
              onCancel={() => setCreating(false)}
            />
          )}
          {!assistants.length && !creating && (
            <p className="assistant-empty">{copy.empty}</p>
          )}
          <div className="assistant-cards">
            {assistants
              .filter(
                (a) => !a.archivedAt && (!a.teamMemberId || a.lifetime === "permanent"),
              )
              .map((a) => (
                <article key={a.id} className="assistant-card">
                  <span className="assistant-avatar">{avatarGlyph(a.name)}</span>
                  <h2>{a.name}</h2>
                  <p className="assistant-note">{a.model.modelId}</p>
                  {connectionMissing(a, models) && (
                    <p className="assistant-state-badge connectionMissing">
                      {copy.status.connectionMissing}
                    </p>
                  )}
                  <div className="assistant-actions">
                    <button className="button primary" onClick={() => open(a)}>
                      {copy.chat}
                    </button>
                    <button
                      className="button secondary"
                      onClick={() =>
                        navigate({
                          view: "agents",
                          assistantId: a.id,
                          agentSettings: true,
                        })
                      }
                    >
                      {copy.settings}
                    </button>
                  </div>
                </article>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
