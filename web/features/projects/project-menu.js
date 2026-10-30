import { projectGroupsCopy as groupsCopy } from "../../lib/i18n/messages/project-groups.js";
import { projectDialogsCopy } from "../../lib/i18n/messages/projects.js";
import { groupNameProblem } from "./project-groups.js";

// The inline message for a group name to refuse ("" when it is fine).
export function groupNameMessage(document, name, exceptId = "") {
  const problem = groupNameProblem(document, name, exceptId);
  return problem === "required"
    ? groupsCopy.nameRequired
    : problem === "taken"
      ? groupsCopy.nameTaken
      : "";
}

/**
 * The ⋯ menu items of a project: one radio item per group (checked on its own),
 * "New group …", "Remove from group" while it is in one, and "Merge older entry"
 * when `onMerge` is given (phones, while an older entry exists).
 */
export function projectMenuItems({
  groups,
  current,
  onMove,
  onNewGroup,
  onRemove,
  onMerge,
}) {
  const after = [
    ...(current
      ? [{ id: "remove", label: groupsCopy.removeFromGroup, run: onRemove }]
      : []),
    // The merge dialog returns focus to the ⋯ trigger it receives.
    ...(onMerge
      ? [
          {
            id: "merge",
            label: projectDialogsCopy.mergeOlder,
            restoreFocus: false,
            run: onMerge,
          },
        ]
      : []),
  ];
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
        // Focus moves on to the new group's name field, then back to the ⋯ trigger.
        {
          id: "new",
          label: groupsCopy.newGroupMenu,
          restoreFocus: false,
          run: onNewGroup,
        },
      ],
    },
    ...(after.length ? [{ id: "separator", kind: "separator" }, ...after] : []),
  ];
}
