import React, { useId } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import { usersCopy } from "../../../lib/i18n/messages/users.js";
import ListCard from "../../../components/ListCard.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { usePageAction } from "../../../app/page-action.js";
import { agentGroupsCopy as copy } from "../../../lib/i18n/messages/agent-groups.js";
import { agentsHubCopy } from "../../../lib/i18n/messages/agents-hub.js";
import AgentRow from "../hub/AgentRow.jsx";
import AreaSection from "./AreaSection.jsx";
import { AgentGroupMenu } from "./GroupMenu.jsx";
import useGroupActions from "./useGroupActions.jsx";
import { areaSections } from "./group-view.js";

export default function GroupedAgents({ lists, rowProps, navigate }) {
  const actions = useGroupActions();
  const id = useId();
  usePageAction("agent-group-add", actions.create);
  const all = [...lists.own, ...lists.ofUsers];
  const row = (a) => (
    <AgentRow
      key={a.id}
      assistant={a}
      {...rowProps(a)}
      groupMenu={<AgentGroupMenu agent={a} actions={actions} />}
    />
  );
  return (
    <section aria-labelledby={id}>
      <GroupLabel
        id={id}
        hint={copy.hint}
        action={{ label: copy.newGroup, disabled: actions.busy, onClick: actions.create }}
      >
        {copy.title}
      </GroupLabel>
      <ErrorMessage error={actions.error} />
      {areaSections(all, actions.groups)
        .filter((section) => section.group || section.agents.length)
        .map((section) => {
          const ids = new Set(section.agents.map((a) => a.id));
          const roots = section.agents.filter(
            (a) => !a.teamMemberId || !ids.has(a.parentAssistantId),
          );
          const children = (root) =>
            section.agents.filter(
              (a) => a.teamMemberId && a.parentAssistantId === root.id,
            );
          return (
            <AreaSection
              key={section.group?.id || "ungrouped"}
              section={{ ...section, agents: roots }}
              actions={actions}
              location="overview"
              flat={!actions.groups.length}
            >
              {roots.length ? (
                <ListCard
                  label={
                    section.group?.name ||
                    (actions.groups.length ? copy.ungrouped : copy.title)
                  }
                >
                  {roots.map((root, index) => (
                    <React.Fragment key={root.id}>
                      {root.userAccess && !roots[index - 1]?.userAccess && (
                        <GroupLabel as="h3">{usersCopy.agentsOfUsers}</GroupLabel>
                      )}
                      {row(root)}
                      {children(root).map(row)}
                    </React.Fragment>
                  ))}
                </ListCard>
              ) : (
                <p className="agent-row-note">{copy.empty}</p>
              )}
            </AreaSection>
          );
        })}
      {lists.ofUsers.length > 0 && (
        <button
          type="button"
          className="button secondary compact"
          onClick={() => navigate({ view: "settings", settingsSection: "users" })}
        >
          {agentsHubCopy.manageUsers}
        </button>
      )}
      {actions.dialog}
    </section>
  );
}
