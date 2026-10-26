import React, { useState } from "react";
import useReturnTarget from "../../../app/useReturnTarget.js";
import useAssistantFeature from "../useAssistantFeature.js";
import useAssistants from "../useAssistants.js";
import { defaultAgentsHubTab } from "../hub-routes.js";
import AllAgentsTab from "./AllAgentsTab.jsx";
import { hubCounts } from "./agent-rows.js";
import HubFrame from "./HubFrame.jsx";
import HubTeamsTab from "./HubTeamsTab.jsx";
import { RuntimeOn } from "./RuntimeTab.jsx";
import TemplatesTab from "./TemplatesTab.jsx";

/**
 * Agenten (handoff 5.2) while agents are on: Alle Agenten, Teams, Vorlagen and
 * Laufzeit, deep-linked by `tab=`. The Runtime tab honours a cross-link's `returnTo`.
 * `children` (the new agent form) shows above All agents.
 */
export default function AgentsHub({
  route,
  navigate,
  openNavigation,
  navigationOpen,
  onOpen,
  error,
  children,
}) {
  const feature = useAssistantFeature();
  const { assistants, teams } = useAssistants();
  const [templates, setTemplates] = useState(null);
  const tab = route.agentsTab || defaultAgentsHubTab;
  const returned = useReturnTarget(route, navigate);
  const frame = {
    tab,
    counts: hubCounts({ assistants, teams, templates }),
    navigate,
    openNavigation,
    navigationOpen,
    origin: tab === "runtime" ? returned : null,
  };
  if (tab === "runtime")
    return <RuntimeOn frame={frame} feature={feature} section={route.agentsSection} />;
  return (
    <HubFrame {...frame}>
      {tab === "teams" ? (
        <HubTeamsTab navigate={navigate} />
      ) : tab === "templates" ? (
        <TemplatesTab navigate={navigate} onTotal={setTemplates} />
      ) : (
        <AllAgentsTab navigate={navigate} onOpen={onOpen} feature={feature} error={error}>
          {children}
        </AllAgentsTab>
      )}
    </HubFrame>
  );
}
