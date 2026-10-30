import { projectGroupsCopy as groupsCopy } from "../../lib/i18n/messages/project-groups.js";

/**
 * The ⋯ menu items of a project: one radio item per group (checked on its own),
 * "New group …", and "Remove from group" while it is in one.
 */
export function projectMenuItems({ groups, current, onMove, onNewGroup, onRemove }) {
  return [
    {
      id: "move",
      kind: "group",
      label: groupsCopy.moveToGroup,
      items: [
        ...groups.map((group) => ({
          id: `group:${group.id}`,
          label: group.name,
          checked: group.id === current?.id,
          run: () => group.id !== current?.id && onMove(group.id),
        })),
        // Focus moves on to the new group's name field.
        {
          id: "new",
          label: groupsCopy.newGroupMenu,
          restoreFocus: false,
          run: onNewGroup,
        },
      ],
    },
    ...(current
      ? [
          { id: "separator", kind: "separator" },
          { id: "remove", label: groupsCopy.removeFromGroup, run: onRemove },
        ]
      : []),
  ];
}
