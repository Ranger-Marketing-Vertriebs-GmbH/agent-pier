import React, { useEffect, useRef, useState } from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import useAssistants from "./useAssistants.js";
import { assistantApi } from "./assistant-api.js";
import { routePath } from "../../app/routes.js";
import AgentWizard from "./wizard/AgentWizard.jsx";
import AgentSettingsPage from "./settings/AgentSettingsPage.jsx";
import AgentBrowserPage from "./browser/AgentBrowserPage.jsx";
import AssistantChat from "./AssistantChat.jsx";
import useSessionViewport from "../sessions/useSessionViewport.js";
import { connectionMissing } from "./connection-state.js";
import AssistantHeader from "./AssistantHeader.jsx";
import { DeletedChat } from "./chats/ChatStates.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import AgentsHub from "./hub/AgentsHub.jsx";
export default function AgentsPage({
  route,
  navigate,
  openNavigation,
  navigationOpen,
  subagentProfiles = null,
}) {
  const {
    assistants,
    conversations = [],
    teams = [],
    models = [],
    error: loadError,
    refresh,
  } = useAssistants();
  const [error, setError] = useState("");
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
  // A link to a chat that is gone (a push notice's, another tab deleted it). The
  // agent's other chats are known by then (its main chat is never deleted); a list
  // without any yet may still be catching up with a chat just opened. A user's own
  // agent has no chat of the owner's: one he cannot list is one he may not read.
  const known = (id) => conversations.some((c) => c.id === id);
  const usersOwn = assistant?.userAccess?.mode === "own";
  if (
    route.conversationId &&
    assistant &&
    !team &&
    !known(route.conversationId) &&
    (usersOwn || conversations.some((c) => c.assistantId === assistant.id))
  )
    return (
      <section className="assistant-detail assistant-chat">
        <AssistantHeader
          assistant={assistant}
          variant="conversation"
          navigate={navigate}
          openNavigation={openNavigation}
          navigationOpen={navigationOpen}
        />
        <DeletedChat
          unavailable={usersOwn}
          onMain={usersOwn ? undefined : () => open(assistant)}
        />
      </section>
    );
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
        takeover={route.takeover === true}
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
        onBack={() => navigate({ view: "agents" })}
        onOpenChat={() => open(assistant)}
        openNavigation={openNavigation}
        navigationOpen={navigationOpen}
        error={error || loadError}
      />
    );
  // "Neuer Agent" (also the sidebar's "Neu › Agent"): the wizard, one per address.
  if (route.creating)
    return <AgentWizard key={routePath(route)} route={route} navigate={navigate} />;
  // An agent page whose agent is not (or not yet) listed.
  if (route.assistantId)
    return (
      <div className="page assistants-page">
        <h1>{copy.settings}</h1>
        <ErrorMessage error={error || loadError} />
        <p>{copy.unavailable}</p>
      </div>
    );
  return (
    <AgentsHub
      route={route}
      navigate={navigate}
      openNavigation={openNavigation}
      navigationOpen={navigationOpen}
      onOpen={open}
      error={error || loadError}
      subagentProfiles={subagentProfiles}
    />
  );
}
