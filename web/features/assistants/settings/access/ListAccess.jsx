import React from "react";
import { agentRoute } from "../agent-settings-fields.js";
import AccessGroup from "./AccessGroup.jsx";
import GrantRow from "./GrantRow.jsx";
import { addIds, candidatesOf, grantedItems, removeId } from "./access-groups.js";

/**
 * A plain grant list of the Access tab (Pipelines, Geheimnisse): granted entries with
 * "Entziehen", the inline add field and the full subpage (`page`). `items` is
 * undefined while loading and null when the source could not be read.
 */
export default function ListAccess({
  assistantId,
  id,
  title,
  hint,
  page,
  items,
  selected,
  onChange,
  typeLabel,
  describe = () => ({}),
  disabled,
  locked = false,
  go,
  setup,
  notes,
  children,
}) {
  return (
    <AccessGroup
      id={id}
      title={title}
      hint={hint}
      entries={grantedItems(items, selected)}
      total={items ? items.length : null}
      loading={items === undefined}
      more={{
        route: agentRoute(assistantId, "access", page),
        open: () => go("access", page),
      }}
      renderRow={(item) => (
        <GrantRow
          key={item.id}
          id={item.id}
          name={item.name}
          sub={describe(item).sub}
          disabled={disabled}
          onRevoke={() => onChange(removeId(selected, item.id))}
        />
      )}
      picker={
        locked
          ? undefined
          : {
              typeLabel,
              candidates: candidatesOf(items, describe),
              granted: selected,
              disabled,
              onAdd: (added) =>
                onChange(
                  addIds(
                    selected,
                    added.map((item) => item.id),
                  ),
                ),
            }
      }
      setup={setup}
      notes={notes}
    >
      {children}
    </AccessGroup>
  );
}
