import React, { useId } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import { usersCopy } from "../../../lib/i18n/messages/users.js";
import ListCard from "../../../components/ListCard.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { usePageAction } from "../../../app/page-action.js";
import { agentGroupsCopy as copy } from "../../../lib/i18n/messages/agent-groups.js";
import { agentsHubCopy } from "../../../lib/i18n/messages/agents-hub.js";
import useMediaQuery from "../../../lib/useMediaQuery.js";
import AgentRow from "../hub/AgentRow.jsx";
import useAssistants from "../useAssistants.js";
import { ownerEntries, sectionKey } from "../order/agent-order.js";
import useAgentOrdering, {
  orderRowClass,
  orderSectionClass,
  useShownOrder,
} from "../order/useAgentOrdering.jsx";
import AreaSection from "./AreaSection.jsx";
import { AgentGroupMenu } from "./GroupMenu.jsx";
import useGroupActions from "./useGroupActions.jsx";
import { overviewSections } from "./group-view.js";
import { ownerOrderWrites } from "./group-api.js";

/**
 * The agents of the overview by group, in the owner's order: dragged with a mouse,
 * long-pressed and dragged on a touch screen, or moved with the ⋯ menu's Move up /
 * Move down, as in the sidebar (useAgentOrdering.jsx). An agent moves with its
 * members.
 */
export default function GroupedAgents({ lists, rowProps, navigate }) {
  const actions = useGroupActions();
  const {
    agentOrder = [],
    loaded = false,
    connected,
    offline,
    refresh,
  } = useAssistants();
  const id = useId();
  usePageAction("agent-group-add", actions.create);
  const finePointer = useMediaQuery("(pointer: fine)");
  const shownOrder = useShownOrder(agentOrder);
  const sections = overviewSections(lists, actions.groups, shownOrder.order);
  const display = ownerEntries(sections);
  const ordering = useAgentOrdering({
    display,
    shown: shownOrder,
    enabled: loaded && connected && !offline,
    ...ownerOrderWrites(refresh),
  });
  const hasGroups = actions.groups.length > 0;
  const row = (a, order) => (
    <AgentRow
      key={a.id}
      assistant={a}
      {...rowProps(a)}
      groupMenu={<AgentGroupMenu agent={a} actions={actions} order={order} />}
    />
  );
  // An agent and its members are placed together; only the agent's own row starts a
  // drag, so a member never seems to leave its lead.
  const entry = (root, members) => {
    const { onTouchStart, ...place } = ordering.rowProps(
      root.id,
      display.find((other) => other.id === root.id),
    );
    return (
      <div
        {...place}
        className={["agents-hub-order", orderRowClass(ordering.drag, root.id)]
          .filter(Boolean)
          .join(" ")}
      >
        <div
          className="agents-hub-order-handle"
          onTouchStart={onTouchStart}
          {...(finePointer && ordering.dragProps(root.id))}
        >
          {row(root, { up: ordering.up(root.id), down: ordering.down(root.id) })}
        </div>
        {members.map((member) => row(member))}
      </div>
    );
  };
  return (
    <section aria-labelledby={id}>
      <GroupLabel
        id={id}
        hint={copy.hint}
        action={{ label: copy.newGroup, disabled: actions.busy, onClick: actions.create }}
      >
        {copy.title}
      </GroupLabel>
      <ErrorMessage error={actions.error || ordering.error} />
      {ordering.status}
      <div
        {...ordering.listProps}
        data-order-section={hasGroups ? undefined : "ungrouped"}
        className={[
          "agents-hub-order-list",
          hasGroups ? "" : orderSectionClass(ordering.drag, "ungrouped"),
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {sections
          // While an agent is dragged an empty Ungrouped takes it out of its group.
          .filter((section) => section.group || section.agents.length || ordering.drag)
          .map((section) => {
            const roots = section.agents;
            return (
              <AreaSection
                key={sectionKey(section)}
                section={section}
                actions={actions}
                location="overview"
                flat={!hasGroups}
                dropProps={{
                  "data-order-section": sectionKey(section),
                  className: orderSectionClass(ordering.drag, sectionKey(section)),
                }}
              >
                {roots.length ? (
                  <ListCard
                    label={
                      section.group?.name || (hasGroups ? copy.ungrouped : copy.title)
                    }
                  >
                    {roots.map((root, index) => (
                      <React.Fragment key={root.id}>
                        {root.userAccess && !roots[index - 1]?.userAccess && (
                          <GroupLabel as="h3">{usersCopy.agentsOfUsers}</GroupLabel>
                        )}
                        {entry(root, section.members(root))}
                      </React.Fragment>
                    ))}
                  </ListCard>
                ) : (
                  <p className="agent-row-note">{copy.empty}</p>
                )}
              </AreaSection>
            );
          })}
      </div>
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
