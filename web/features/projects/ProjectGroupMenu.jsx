import React from "react";
import Icon from "../../components/Icon.jsx";
import { projectGroupsCopy as copy } from "../../lib/i18n/messages/project-groups.js";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";

/**
 * The ⋯ button of a group header and its menu: rename, move up / down (hidden at the
 * ends) and delete. The header's own button stays the collapse toggle.
 */
export default function ProjectGroupMenu({
  group,
  first,
  last,
  onRename,
  onMove,
  onDelete,
}) {
  const menu = useRowMenu();
  const label = copy.groupActions(group.name);
  const items = [
    // Focus goes to the name field, then back to this button.
    { id: "rename", label: copy.renameGroup, restoreFocus: false, run: onRename },
    ...(first ? [] : [{ id: "up", label: copy.moveGroupUp, run: () => onMove(-1) }]),
    ...(last ? [] : [{ id: "down", label: copy.moveGroupDown, run: () => onMove(1) }]),
    { id: "separator", kind: "separator" },
    { id: "delete", label: copy.deleteGroup, danger: true, run: onDelete },
  ];
  return (
    <>
      <button
        type="button"
        className="icon-button project-group-more"
        data-group-id={group.id}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <Icon name="more" size={18} />
      </button>
      <RowMenu label={label} state={menu} items={items} />
    </>
  );
}
