import React from "react";
import Icon from "../../../components/Icon.jsx";
import { RowMenu, useRowMenu } from "../../extensions/RowMenu.jsx";
import { agentGroupsCopy as copy } from "../../../lib/i18n/messages/agent-groups.js";
import { groupOf } from "./group-view.js";

function Menu({ label, items, disabled }) {
  const menu = useRowMenu();
  return (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        disabled={disabled}
        onClick={menu.toggle}
      >
        <Icon name="more" />
      </button>
      <RowMenu label={label} state={menu} items={items} sheet={{ title: label }} />
    </>
  );
}
export function AgentGroupMenu({ agent, actions }) {
  if (agent.teamMemberId) return null;
  const current = groupOf(actions.groups, agent.id);
  return (
    <Menu
      label={copy.actions(agent.name)}
      disabled={actions.busy}
      items={[
        {
          id: "move",
          kind: "group",
          label: copy.moveTo,
          items: [
            ...actions.groups.map((g) => ({
              id: g.id,
              label: g.name,
              checked: g.id === current,
              run: () => g.id !== current && actions.move(agent, g.id),
            })),
            {
              id: "ungrouped",
              label: copy.ungrouped,
              checked: current === null,
              run: () => current !== null && actions.move(agent, null),
            },
          ],
        },
      ]}
    />
  );
}
export default function GroupMenu({ group, actions }) {
  const index = actions.groups.findIndex((g) => g.id === group.id);
  return (
    <Menu
      label={copy.actions(group.name)}
      disabled={actions.busy}
      items={[
        {
          id: "rename",
          label: copy.rename,
          restoreFocus: false,
          run: () => actions.rename(group),
        },
        ...(index > 0
          ? [{ id: "up", label: copy.up, run: () => actions.reorder(group, "up") }]
          : []),
        ...(index < actions.groups.length - 1
          ? [{ id: "down", label: copy.down, run: () => actions.reorder(group, "down") }]
          : []),
        {
          id: "delete",
          label: copy.remove,
          danger: true,
          restoreFocus: false,
          run: () => actions.remove(group),
        },
      ]}
    />
  );
}
