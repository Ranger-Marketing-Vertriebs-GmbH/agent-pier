import React, { useId } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { agentsHubCopy as copy } from "../../../lib/i18n/messages/agents-hub.js";
import { usersCopy } from "../../../lib/i18n/messages/users.js";
import useAssistants from "../useAssistants.js";
import AgentRow from "./AgentRow.jsx";
import { agentPills, hubLists } from "./agent-rows.js";
import ArchiveGroup from "./ArchiveGroup.jsx";
import FirstAgent from "./FirstAgent.jsx";
import { activationPhase, serviceDown } from "./hub-model.js";
import { ActivationProgress, ServiceStopped } from "./HubStates.jsx";
import ReadinessCard from "./ReadinessCard.jsx";
import { useServiceAction } from "./RuntimeServiceGroup.jsx";
import useHubSummaries from "./useHubSummaries.js";

const usersRoute = { view: "settings", settingsSection: "users" };

function AgentList({ id, title, count, action, agents, rowProps }) {
  if (!agents.length) return null;
  return (
    <section aria-labelledby={id}>
      <GroupLabel id={id} action={action}>
        {title}
        {count !== undefined && <span className="agents-hub-count">{count}</span>}
      </GroupLabel>
      <ListCard labelledBy={id}>
        {agents.map((a) => (
          <AgentRow key={a.id} assistant={a} {...rowProps(a)} />
        ))}
      </ListCard>
    </section>
  );
}

/**
 * Alle Agenten (handoff 5.2): readiness, the owner's agents, agents of users and the
 * archive; the activation progress, a stopped service and "no agent yet" as states.
 */
export default function AllAgentsTab({ navigate, onOpen, feature, error }) {
  const { assistants, models = [], runtime, activity } = useAssistants();
  const lists = hubLists(assistants);
  const listed = [...lists.own, ...lists.ofUsers];
  const summaries = useHubSummaries(
    listed.map((a) => a.id),
    true,
  );
  const service = useServiceAction();
  const ownId = useId(),
    usersId = useId();
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
      {!listed.length && (
        <FirstAgent
          runtime={runtime}
          models={models}
          webSearchReady={summaries.webSearchReady}
          navigate={navigate}
        />
      )}
      <AgentList
        id={ownId}
        title={copy.yourAgents}
        count={lists.own.length}
        agents={lists.own}
        rowProps={rowProps}
      />
      <AgentList
        id={usersId}
        title={usersCopy.agentsOfUsers}
        agents={lists.ofUsers}
        rowProps={rowProps}
        action={{
          label: copy.manageUsers,
          onClick: () => navigate(usersRoute),
        }}
      />
      <ArchiveGroup archived={lists.archived} navigate={navigate} />
    </>
  );
}
