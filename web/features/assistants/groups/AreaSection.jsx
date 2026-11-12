import React from "react";
import SidebarGroup from "../../../app/SidebarGroup.jsx";
import StatusDot from "../../../components/StatusDot.jsx";
import { agentGroupsCopy as copy } from "../../../lib/i18n/messages/agent-groups.js";
import GroupMenu from "./GroupMenu.jsx";
import { areaStatus } from "./group-view.js";
import useAssistants from "../useAssistants.js";
import "./groups.css";

// Reuse the sidebar's accessible, persisted disclosure for both group views.
// `dropProps` mark the section as a drop target of the agent order.
export default function AreaSection({
  section,
  actions,
  children,
  selected = "",
  location,
  flat = false,
  dropProps,
}) {
  const { assistants, activity } = useAssistants();
  const { group, agents } = section;
  // Without any group the ungrouped bucket is just the list: no header, no fold.
  if (flat && !group) return children;
  const status = areaStatus(agents, assistants, activity);
  const active =
    selected &&
    agents.some(
      (a) =>
        a.id === selected ||
        assistants.some(
          (child) => child.id === selected && child.parentAssistantId === a.id,
        ),
    );
  return (
    <div
      {...dropProps}
      className={["agent-area-section", dropProps?.className].filter(Boolean).join(" ")}
    >
      <SidebarGroup
        name={`agent-area-${location}-${group?.id || "ungrouped"}`}
        label={group?.name || copy.ungrouped}
        count={String(agents.length)}
        defaultOpen
        activeKey={active ? selected : ""}
        actions={
          <>
            {status && (
              <StatusDot
                tone={status === "attention" ? "warning" : "working"}
                label={copy[status]}
                title={copy[status]}
                pulse={status === "working"}
              />
            )}
            {group && <GroupMenu group={group} actions={actions} />}
          </>
        }
      >
        {children}
      </SidebarGroup>
    </div>
  );
}
