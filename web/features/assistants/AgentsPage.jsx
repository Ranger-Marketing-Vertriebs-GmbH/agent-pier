import { avatarGlyph } from "./avatar-glyph.js";
import React, { useEffect, useRef, useState } from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useAssistants from "./useAssistants.js";
import { assistantApi } from "./assistant-api.js";
import AgentCreate from "./settings/AgentCreate.jsx";
import AgentSettingsPage from "./settings/AgentSettingsPage.jsx";
import AgentBrowserPage from "./browser/AgentBrowserPage.jsx";
import AssistantChat from "./AssistantChat.jsx";
import useSessionViewport from "../sessions/useSessionViewport.js";
import { connectionMissing } from "./connection-state.js";
import { useCrossLink } from "../../app/cross-link.js";
export default function AgentsPage({ route, navigate, openNavigation, navigationOpen }) {
  const {
    assistants,
    teams = [],
    models = [],
    error: loadError,
    refresh,
  } = useAssistants();
  const [creating, setCreating] = useState(Boolean(route.creating)),
    [error, setError] = useState("");
  const assistant = assistants.find((a) => a.id === route.assistantId);
  const request = useRef(null);
  const crossLink = useCrossLink();
  useEffect(
    () => () => {
      request.current = null;
    },
    [route],
  );
  // The sidebar's "New > Agent" arrives with the flag while this page may be open.
  useEffect(() => {
    if (route.creating) setCreating(true);
  }, [route.creating]);
  const stopCreating = () => {
    setCreating(false);
    if (route.creating) navigate({ view: "agents" });
  };
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
  // Without its connection the chat cannot open; the agent list is the way out.
  function back(a) {
    if (connectionMissing(a, models)) navigate({ view: "agents" });
    else open(a);
  }
  // A team task opens in the parent chat that proposed it.
  const team =
    route.teamId &&
    teams.find((t) => t.id === route.teamId && t.parentAssistantId === route.assistantId);
  const conversationId = route.conversationId || team?.parentConversationId;
  // Settings on phones scroll inside their own container under the fixed header, so
  // the visual viewport (keyboard) must size the app like the chat does.
  useSessionViewport(Boolean(route.agentSettings && assistant && !conversationId));
  if (conversationId && assistant)
    return (
      <AssistantChat
        key={conversationId}
        assistant={assistant}
        conversationId={conversationId}
        focusTeamId={team?.id}
        navigate={navigate}
        openNavigation={openNavigation}
        navigationOpen={navigationOpen}
      />
    );
  if (route.agentBrowser && assistant)
    return (
      <AgentBrowserPage
        key={assistant.id}
        assistant={assistant}
        navigate={navigate}
        onBack={() => back(assistant)}
        openNavigation={openNavigation}
        navigationOpen={navigationOpen}
      />
    );
  if (route.agentSettings && assistant)
    return (
      <AgentSettingsPage
        key={assistant.id}
        assistant={assistant}
        route={route}
        navigate={navigate}
        onBack={() => back(assistant)}
        openNavigation={openNavigation}
        navigationOpen={navigationOpen}
        error={error || loadError}
      />
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
          onClick={() =>
            navigate(crossLink({ view: "settings", settingsSection: "assistants" }))
          }
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
            <AgentCreate
              navigate={navigate}
              onCreated={(created) => {
                setCreating(false);
                navigate({
                  view: "agents",
                  assistantId: created.id,
                  agentSettings: true,
                });
              }}
              onCancel={stopCreating}
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
