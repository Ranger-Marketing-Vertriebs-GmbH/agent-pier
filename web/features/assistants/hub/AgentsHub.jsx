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
import SkillCatalogTab from "./SkillCatalogTab.jsx";
import TemplatesTab from "./TemplatesTab.jsx";

/**
 * Agenten (handoff 5.2) while agents are on: Alle Agenten, Teams, Vorlagen, Skills
 * (the owner's skill catalog) and Laufzeit, deep-linked by `tab=`. The Runtime tab honours a cross-link's `returnTo`.
 * `subagentProfiles`: whether a shared CLI profile exists for Coding › Unteragenten
 * (null while unknown).
 */
export default function AgentsHub({
  route,
  navigate,
  openNavigation,
  navigationOpen,
  onOpen,
  error,
  subagentProfiles = null,
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
      ) : tab === "skills" ? (
        <SkillCatalogTab />
      ) : tab === "templates" ? (
        <TemplatesTab
          navigate={navigate}
          onTotal={setTemplates}
          subagentProfiles={subagentProfiles}
        />
      ) : (
        <AllAgentsTab
          navigate={navigate}
          onOpen={onOpen}
          feature={feature}
          error={error}
        />
      )}
    </HubFrame>
  );
}
