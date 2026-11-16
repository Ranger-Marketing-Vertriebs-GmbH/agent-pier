import React, { useEffect, useMemo } from "react";
import { slotSurfaces, surfaceKey } from "./runtime-surfaces.js";
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
 * A named slot of a page AgentPier owns (docs/adr/0007-runtime-descriptor.md): for
 * every runtime of the runtime list, in its order, each surface the server lists for
 * slot `name` that shows now (runtime-surfaces.js), rendered by the component the
 * runtime's web module registers under the surface's id. Nothing while there is none.
 *
 * A surface receives `runtime` (its list entry, with the install state), `context`
 * (what the slot's page offers: here `navigate`), `list` (`{ error, refresh,
 * written }` of the runtime list: `written()` follows an action whose change the list
 * pushes, useLiveTopic) and, the first of the slot, `anchor`: the element id `id` a
 * link to the slot scrolls to. `onSettled()` tells the page that the list was read
 * (or failed), so what the slot shows is on screen.
 */
export default function RuntimeSlot({ name, context, id, onSettled }) {
  const { runtimes, loading, error, refresh, written } = useRuntimes();
  const list = useMemo(() => ({ error, refresh, written }), [error, refresh, written]);
  useEffect(() => {
    if (!loading) onSettled?.();
  }, [loading, onSettled]);
  return slotSurfaces(runtimes, name)
    .map((shown) => ({ ...shown, Component: componentOf(shown.runtime, shown.surface) }))
    .filter(({ Component }) => Component)
    .map(({ runtime, surface, Component }, index) => (
      <Component
        key={surfaceKey({ runtime, surface })}
        runtime={runtime}
        context={context}
        list={list}
        anchor={index === 0 ? id : undefined}
      />
    ));
}
