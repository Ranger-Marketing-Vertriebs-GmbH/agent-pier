import { leadRequestCopy } from "../../../lib/i18n/messages/lead-requests.js";

const copy = () => leadRequestCopy.groups;

/** The ⋯ items of a group: rename and delete. */
export function groupMenuItems({ onRename, onDelete }) {
  return [
    { id: "rename", label: copy().rename, restoreFocus: false, run: onRename },
    { id: "separator", kind: "separator" },
    {
      id: "delete",
      label: copy().remove,
      danger: true,
      restoreFocus: false,
      run: onDelete,
    },
  ];
}

/**
 * The ⋯ items of a permanent member: one radio item per group (checked on its own;
 * picking another moves it there in one step), "New group …", and "Remove from
 * group" while it is in one.
 */
export function memberMenuItems({ groups, current, onMove, onNewGroup }) {
  return [
    {
      id: "move",
      kind: "group",
      label: copy().moveTo,
      items: [
        ...groups.map((group) => ({
          id: `group:${group.id}`,
          label: group.name,
          checked: group.id === current?.id,
          run: () => group.id !== current?.id && onMove(group.id),
        })),
        { id: "new", label: copy().newGroupMenu, restoreFocus: false, run: onNewGroup },
      ],
    },
    ...(current
      ? [
          { id: "separator", kind: "separator" },
          { id: "remove", label: copy().takeOut, run: () => onMove(null) },
        ]
      : []),
  ];
}
