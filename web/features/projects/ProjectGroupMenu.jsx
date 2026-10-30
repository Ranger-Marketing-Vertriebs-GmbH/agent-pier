import React from "react";
import { projectGroupsCopy as copy } from "../../lib/i18n/messages/project-groups.js";
import ProjectMenuButton from "./ProjectMenuButton.jsx";

/**
 * The ⋯ button of a group header and its menu (a sheet titled with the group on
 * phones): rename, move up / down (hidden at the ends) and delete. The header's own
 * button stays the collapse toggle.
 */
export default function ProjectGroupMenu({
  group,
  first,
  last,
  phone = false,
  onRename,
  onMove,
  onDelete,
}) {
  const items = [
    // Focus goes to the name field, then back to this button.
    { id: "rename", label: copy.renameGroup, restoreFocus: false, run: onRename },
    ...(first ? [] : [{ id: "up", label: copy.moveGroupUp, run: () => onMove(-1) }]),
    ...(last ? [] : [{ id: "down", label: copy.moveGroupDown, run: () => onMove(1) }]),
    { id: "separator", kind: "separator" },
    { id: "delete", label: copy.deleteGroup, danger: true, run: onDelete },
  ];
  return (
    <ProjectMenuButton
      className="project-group-more"
      data-group-id={group.id}
      label={copy.groupActions(group.name)}
      items={items}
      sheet={phone ? { title: group.name } : null}
    />
  );
}
