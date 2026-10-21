import React, { useCallback } from "react";
import { assistantBrowserCopy as copy } from "../../../lib/i18n/messages/assistant-browser.js";
import AssistantHeader from "../AssistantHeader.jsx";
import AgentBrowserView from "./AgentBrowserView.jsx";

/**
 * The owner's live view of an agent's own browser (/agents/:id/browser).
 * `takeover` (from ?takeover=1) takes over as soon as the picture is live.
 */
export default function AgentBrowserPage({
  assistant,
  navigate,
  onBack,
  openNavigation,
  navigationOpen,
  takeover = false,
}) {
  // Taken over from ?takeover=1: the address drops it, so a reload only watches.
  const onControl = useCallback(
    (mine) => {
      if (takeover && mine)
        navigate(
          { view: "agents", assistantId: assistant.id, agentBrowser: true },
          true,
          true,
        );
    },
    [takeover, navigate, assistant.id],
  );
  return (
    <section className="assistant-detail agent-browser-page">
      <AssistantHeader
        assistant={assistant}
        variant="settings"
        subtitle={copy.liveTitle}
        navigate={navigate}
        onBack={onBack}
        openNavigation={openNavigation}
        navigationOpen={navigationOpen}
      />
      <AgentBrowserView assistant={assistant} takeover={takeover} onControl={onControl} />
    </section>
  );
}
