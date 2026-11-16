import React, { useEffect, useMemo } from "react";
import { slotEntries, surfaceKey } from "./runtime-surfaces.js";
import { runtimeFieldCopy } from "./runtimes/fields.js";
import { webRuntime } from "./runtimes/index.js";
import useRuntimes from "./useRuntimes.js";

// The surfaces already reported as lacking a component, so each is named once.
const reported = new Set();

// The component runtime `runtime` registers for `surface`; none is reported once in
// development, and the surface renders nothing.
function componentOf(runtime, surface) {
  const Component = webRuntime(runtime.id)?.surfaces?.[surface.id];
  const key = surfaceKey({ runtime, surface });
  if (!Component && import.meta.env.DEV && !reported.has(key)) {
    reported.add(key);
    console.warn(`Runtime surface ${key} has no component in the web app.`);
  }
  return Component;
}

/**
 * The texts of described field `fieldId` of runtime `runtimeId` (runtimes/fields.js),
 * for the page whose draft holds the field: only the slot asks the runtime modules.
 */
export const describedFieldCopy = runtimeFieldCopy;

/**
 * A named slot of a page AgentPier owns (docs/adr/0007-runtime-descriptor.md): for
 * every runtime of the runtime list, in its order, each surface the server lists for
 * slot `name` that shows now (runtime-surfaces.js). A built surface is rendered by
 * the component the runtime's web module registers under the surface's id; a
 * described one by `Described`, the page's component for a list of fields, which
 * also receives `surface` (with its `fields`) and `copy(fieldId)`, the field's texts
 * from the runtime's catalog namespace. Nothing while there is none.
 *
 * A surface receives `runtime` (its list entry, with the install state), `context`
 * (what the slot's page offers: here `navigate`), `list` (`{ error, refresh,
 * written }` of the runtime list: `written()` follows an action whose change the list
 * pushes, useLiveTopic) and, the first of the slot, `anchor`: the element id `id` a
 * link to the slot scrolls to. `onSettled()` tells the page that the list was read
 * (or failed), so what the slot shows is on screen.
 */
export default function RuntimeSlot({ name, context, id, onSettled, Described }) {
  const { runtimes, loading, error, refresh, written } = useRuntimes();
  const list = useMemo(() => ({ error, refresh, written }), [error, refresh, written]);
  useEffect(() => {
    if (!loading) onSettled?.();
  }, [loading, onSettled]);
  return slotEntries(runtimes, name)
    .map((shown) => ({
      ...shown,
      Component:
        shown.surface.kind === "described"
          ? Described
          : componentOf(shown.runtime, shown.surface),
    }))
    .filter(({ Component }) => Component)
    .map(({ runtime, surface, Component }, index) =>
      surface.kind === "described" ? (
        <Component
          key={surfaceKey({ runtime, surface })}
          runtime={runtime}
          surface={surface}
          context={context}
          copy={(fieldId) => runtimeFieldCopy(runtime.id, fieldId)}
        />
      ) : (
        <Component
          key={surfaceKey({ runtime, surface })}
          runtime={runtime}
          context={context}
          list={list}
          anchor={index === 0 ? id : undefined}
        />
      ),
    );
}
