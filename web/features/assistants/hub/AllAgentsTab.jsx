import React from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupedAgents from "../groups/GroupedAgents.jsx";
import useAssistants from "../useAssistants.js";
import { agentPills, hubLists } from "./agent-rows.js";
import ArchiveGroup from "./ArchiveGroup.jsx";
import FirstAgent from "./FirstAgent.jsx";
import { activationPhase, serviceDown } from "./hub-model.js";
import { ActivationProgress, ServiceStopped } from "./HubStates.jsx";
import ReadinessCard from "./ReadinessCard.jsx";
import { useServiceAction } from "./RuntimeServiceGroup.jsx";
import useHubSummaries from "./useHubSummaries.js";

/**
 * Alle Agenten (handoff 5.2): readiness, the owner's agents, agents of users and the
 * archive; the activation progress, a stopped service and "no agent yet" as states.
 */
export default function AllAgentsTab({ navigate, onOpen, feature, error }) {
  const { assistants, models = [], runtime, activity, loaded = false } = useAssistants();
  const lists = hubLists(assistants);
  const listed = [...lists.own, ...lists.ofUsers];
  const summaries = useHubSummaries(
    listed.map((a) => a.id),
    true,
  );
  const service = useServiceAction();
  const phase = activationPhase({
    saving: feature.saving,
    enabled: feature.enabled,
    availability: runtime?.availability,
  });
  const rowProps = (a) => ({
    models,
    runtime,
    activity,
    navigate,
    onOpen,
    pills: agentPills(
      a,
      summaries.policies[a.id] || null,
      summaries.telegram ? summaries.telegram.has(a.id) : null,
    ),
  });
  return (
    <>
      {phase && <ActivationProgress phase={phase} />}
      {!phase && serviceDown(runtime) && (
        <ServiceStopped
          onStart={() => service.operate("enable")}
          busy={service.busy}
          error={service.error}
          navigate={navigate}
        />
      )}
      <ErrorMessage error={error} />
      {!phase && (
        <ReadinessCard
          runtime={runtime}
          webSearchReady={summaries.webSearchReady}
          updateReady={summaries.updateReady}
          navigate={navigate}
        />
      )}
      {/* Only once the list is in: before it, "no agent yet" would flash. */}
      {loaded && !listed.length && (
        <FirstAgent
          runtime={runtime}
          models={models}
          webSearchReady={summaries.webSearchReady}
          navigate={navigate}
        />
      )}
      <GroupedAgents lists={lists} rowProps={rowProps} navigate={navigate} />
      <ArchiveGroup archived={lists.archived} navigate={navigate} />
    </>
  );
}
