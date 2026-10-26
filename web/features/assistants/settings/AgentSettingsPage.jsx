import React, { useEffect, useRef } from "react";
import PendingRestartNotice from "../PendingRestartNotice.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import UnderlineTabs from "../../../components/UnderlineTabs.jsx";
import { assistantSettingsCopy as copy } from "../../../lib/i18n/messages/assistant-settings.js";
import { routePath } from "../../../app/routes.js";
import { useReturnScroll } from "../../../app/return-scroll.js";
import AssistantHeader from "../AssistantHeader.jsx";
import useAssistants from "../useAssistants.js";
import { agentRoute, resolveAgentLocation } from "./agent-settings-fields.js";
import AgentHeaderActions from "./AgentHeaderActions.jsx";
import OverviewTab from "./OverviewTab.jsx";
import IdentityTab from "./IdentityTab.jsx";
import CapabilitiesTab from "./CapabilitiesTab.jsx";
import AccessTab from "./AccessTab.jsx";
import TeamTab from "./TeamTab.jsx";
import AutomationTab from "./AutomationTab.jsx";
import ChannelsTab from "./ChannelsTab.jsx";
import RuntimeSummary from "./RuntimeSummary.jsx";
import "../agent-settings.css";

const panels = {
  overview: OverviewTab,
  identity: IdentityTab,
  capabilities: CapabilitiesTab,
  access: AccessTab,
  team: TeamTab,
  automation: AutomationTab,
  channels: ChannelsTab,
};

/**
 * Agent settings in seven tabs by purpose (handoff 5.4): one draft and save bar per
 * tab, subpages inside their tab, all addressed by `agentTab`/`agentPage` so every
 * switch passes the unsaved-changes guard.
 */
export default function AgentSettingsPage({
  assistant,
  route,
  navigate,
  onBack,
  onOpenChat,
  openNavigation,
  navigationOpen,
  error,
}) {
  const { runtime } = useAssistants();
  const { tab, page, tabs, normalized } = resolveAgentLocation(assistant, route);
  useEffect(() => {
    if (normalized) navigate(agentRoute(assistant.id, tab, page), true, true);
  }, [normalized, assistant.id, tab, page, navigate]);
  const go = (nextTab, nextPage = "") =>
    navigate(agentRoute(assistant.id, nextTab, nextPage));
  const scroller = useRef(null);
  // Back from a cross-link target (Zugänge, agent service) lands where the owner was.
  useReturnScroll(
    scroller,
    routePath(agentRoute(assistant.id, tab, page, route.agentHook)),
  );
  const Panel = panels[tab];
  const props = {
    assistant,
    page,
    go,
    navigate,
    focusTeamId: route.agentTeam,
    hookId: route.agentHook,
  };
  return (
    <section className="assistant-detail assistant-settings-page agent-settings">
      <AssistantHeader
        assistant={assistant}
        variant="settings"
        navigate={navigate}
        onBack={onBack}
        backLabel={copy.backToAgents}
        openNavigation={openNavigation}
        navigationOpen={navigationOpen}
        actions={
          <AgentHeaderActions
            assistant={assistant}
            navigate={navigate}
            onOpenChat={onOpenChat}
          />
        }
      />
      <div className="agent-settings-tabs">
        <UnderlineTabs
          label={copy.tabsLabel}
          idPrefix="agent-settings"
          tabs={tabs.map((id) => ({ id, label: copy.tabs[id] }))}
          selected={tab}
          onSelect={(id) => {
            if (id !== tab || page) go(id);
          }}
        />
      </div>
      <div className="assistant-settings-scroll" ref={scroller}>
        <ErrorMessage error={error} />
        <PendingRestartNotice />
        <div className="agent-settings-layout">
          <div
            className="agent-settings-main"
            role="tabpanel"
            id={`agent-settings-tabpanel-${tab}`}
            aria-labelledby={`agent-settings-tab-${tab}`}
          >
            <Panel key={assistant.id} {...props} />
          </div>
          <RuntimeSummary
            as="aside"
            className="agent-runtime-aside"
            runtime={runtime}
            navigate={navigate}
          />
        </div>
      </div>
    </section>
  );
}
