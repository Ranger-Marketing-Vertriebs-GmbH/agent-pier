import React from "react";
import useReturnTarget from "../../app/useReturnTarget.js";
import { defaultAgentsHubTab } from "./hub-routes.js";
import HubFrame from "./hub/HubFrame.jsx";
import { AgentsOffState } from "./hub/HubStates.jsx";
import RuntimeOff from "./hub/RuntimeOff.jsx";
import useAssistantFeature from "./useAssistantFeature.js";

/**
 * Agenten while agents are switched off (handoff 5.2, 5.10): the hub's frame with
 * "Agenten sind ausgeschaltet" and "Agenten aktivieren" on every tab but Runtime,
 * which keeps the switch with its save bar. Loads no agent data and no agent styles.
 */
export default function AgentsOff({ route, navigate, openNavigation, navigationOpen }) {
  const feature = useAssistantFeature();
  const tab = route.agentsTab || defaultAgentsHubTab;
  const returned = useReturnTarget(route, navigate);
  const frame = {
    tab,
    navigate,
    openNavigation,
    navigationOpen,
    actions: false,
    origin: tab === "runtime" ? returned : null,
  };
  if (tab === "runtime") return <RuntimeOff frame={frame} feature={feature} />;
  return (
    <HubFrame {...frame}>
      <AgentsOffState feature={feature} />
    </HubFrame>
  );
}
