import React, { useId } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import Icon from "../../../components/Icon.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../../components/ListRow.jsx";
import useResource from "../../../lib/useResource.js";
import { routePath } from "../../../app/routes.js";
import { assistantWorkflowCopy as wf } from "../../../lib/i18n/messages/assistant-workflows.js";
import { assistantSettingsCopy as copy } from "../../../lib/i18n/messages/assistant-settings.js";
import useAssistants from "../useAssistants.js";
import { agentRoute, isPersonal, visibleAgentTabs } from "./agent-settings-fields.js";
import useActionHistory from "./useActionHistory.js";
import useAgentLifecycle from "./useAgentLifecycle.js";
import AgentLifecycleDialogs from "./AgentLifecycleDialogs.jsx";
import { agentsHubRoute } from "../hub-routes.js";
import { agentLifecycleCopy as lifecycleCopy } from "../../../lib/i18n/messages/agent-lifecycle.js";
import ActionHistory from "./ActionHistory.jsx";
import AttachmentStorageGroup from "./AttachmentStorageGroup.jsx";
import MemberGroup from "./MemberGroup.jsx";
import RuntimeSummary from "./RuntimeSummary.jsx";
import { manageItems } from "./AgentHeaderActions.jsx";
import {
  accessSummary,
  automationSummary,
  capabilitySummary,
  channelSummary,
  identitySummary,
  teamSummary,
} from "./overview-glance.js";

/** "Auf einen Blick": one read-only summary row per tab, each opening its tab. */
function AtAGlance({ assistant, go }) {
  const id = useId();
  const { policies = {}, teams = [] } = useAssistants();
  const personal = isPersonal(assistant);
  const access = useResource(
    personal ? `/assistants/${encodeURIComponent(assistant.id)}/access` : null,
  );
  const channels = useResource(personal ? "/assistant-channels" : null);
  const values = {
    identity: identitySummary(assistant),
    capabilities: capabilitySummary(assistant),
    access: personal ? accessSummary(access.data, assistant) : undefined,
    team: teamSummary(policies[assistant.id], teams, assistant.id),
    automation: automationSummary(assistant),
    channels: channelSummary(channels.data?.channels, assistant.id),
  };
  const tabs = visibleAgentTabs(assistant).filter((tab) => tab !== "overview");
  return (
    <section id="agent-glance" aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.overviewGroups.glanceHint}>
        {copy.overviewGroups.glance}
      </GroupLabel>
      <ListCard labelledBy={id}>
        {tabs.map((tab) => (
          <ListRow
            key={tab}
            label={copy.tabs[tab]}
            sub={values[tab] ?? (values[tab] === null ? unknownValue : undefined)}
            href={routePath(agentRoute(assistant.id, tab))}
            onClick={() => go(tab)}
          />
        ))}
      </ListCard>
    </section>
  );
}

/** Verwalten: Duplizieren, Archivieren/Wiederherstellen and Endgültig löschen. */
function ManageGroup({ assistant, navigate }) {
  const id = useId();
  const lifecycle = useAgentLifecycle(assistant);
  const items = manageItems({ assistant, lifecycle, navigate });
  if (!items.length) return null;
  const hints = {
    duplicate: copy.duplicateHint,
    archive: copy.archiveHint,
    delete: lifecycleCopy.deleteHint,
  };
  return (
    <section id="agent-manage" aria-labelledby={id}>
      <GroupLabel id={id}>{copy.overviewGroups.manage}</GroupLabel>
      <ErrorMessage error={lifecycle.error} />
      <ListCard labelledBy={id}>
        {items.map((item) => (
          <ListRow
            key={item.id}
            label={item.label}
            sub={hints[item.id]}
            disabled={item.disabled}
            onClick={item.run}
          />
        ))}
      </ListCard>
      <AgentLifecycleDialogs
        assistant={assistant}
        lifecycle={lifecycle}
        onDeleted={() => navigate(agentsHubRoute())}
      />
    </section>
  );
}

/**
 * Überblick (handoff 5.4): what waits for the owner, the agent's actions and coding
 * tasks (`page=actions`), a summary of every tab, chat attachments, the team member
 * card and Verwalten. On narrow screens the agent service sits here, too.
 */
export default function OverviewTab({ assistant, page, go, navigate }) {
  const personal = isPersonal(assistant);
  const { runtime } = useAssistants();
  const history = useActionHistory(personal ? assistant.id : "");
  if (personal && page === "actions")
    return (
      <ActionHistory
        history={history}
        assistantId={assistant.id}
        onBack={() => go("overview")}
      />
    );
  return (
    <>
      {personal && history.pending > 0 && (
        <button
          type="button"
          className="agent-pending-strip"
          onClick={() => go("overview", "actions")}
        >
          {copy.pendingApprovals(history.pending)}
          <Icon name="chevron" size={14} />
        </button>
      )}
      {personal && (
        <ListCard label={wf.actions}>
          <ListRow
            label={wf.actions}
            value={history.loaded ? history.actions.length : unknownValue}
            href={routePath(agentRoute(assistant.id, "overview", "actions"))}
            onClick={() => go("overview", "actions")}
          />
        </ListCard>
      )}
      <AtAGlance assistant={assistant} go={go} />
      {assistant.teamMemberId && <MemberGroup assistant={assistant} />}
      <AttachmentStorageGroup assistant={assistant} />
      <ManageGroup assistant={assistant} navigate={navigate} />
      <RuntimeSummary
        className="agent-runtime-group"
        runtime={runtime}
        navigate={navigate}
      />
    </>
  );
}
