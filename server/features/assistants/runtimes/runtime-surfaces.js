// The surfaces of the agent runtimes (docs/adr/0007-runtime-descriptor.md): UI a
// runtime registers at a named slot of a page AgentPier owns. A runtime states them in
// its descriptor (runtimes/<id>/descriptor.js); the runtime list and an agent's
// `runtimeInfo` carry them, and the web app renders each with the component the
// runtime's web module registers under the same id
// (web/features/assistants/runtimes/<id>/index.js, RuntimeSlot.jsx).

/**
 * The slots, by the page that renders them. AgentPier owns the list; a slot is added
 * with the first surface that needs it.
 * - `hub.runtime`: a group of Agents › Runtime.
 */
export const RUNTIME_SLOTS = Object.freeze(["hub.runtime"]);

// How a surface is made: `built` is a component of the runtime's web module.
const SURFACE_KINDS = Object.freeze(["built"]);

// When a surface shows: `whileEnabled` while a new agent may run on the runtime (the
// list entry's `ready`), the default; `always` also before, as the install group of
// an optional runtime must.
const SURFACE_SHOWS = Object.freeze(["whileEnabled", "always"]);

const KEYS = Object.freeze(["id", "slot", "kind", "shows"]);

/**
 * The surfaces `stated` (`[{ id, slot, kind, shows? }]`) of runtime `runtime`, each
 * with its `shows` rule, deep-frozen. A missing or repeated id, a slot, kind or
 * `shows` AgentPier does not name and any further key throw a TypeError naming the
 * runtime and the surface.
 */
export function resolveSurfaces(stated = [], runtime = "") {
  const fail = (text) => {
    throw new TypeError(`Runtime surface of ${runtime}: ${text}`);
  };
  if (!Array.isArray(stated)) fail("surfaces must be a list");
  const seen = new Set();
  return Object.freeze(
    stated.map((surface) => {
      const { id, slot, kind, shows = SURFACE_SHOWS[0] } = surface || {};
      if (typeof id !== "string" || !id) fail("a surface needs an id");
      if (seen.has(id)) fail(`duplicate surface id ${id}`);
      seen.add(id);
      const refuse = (text) => fail(`${id}: ${text}`);
      if (!RUNTIME_SLOTS.includes(slot)) refuse(`unknown slot ${JSON.stringify(slot)}`);
      if (!SURFACE_KINDS.includes(kind)) refuse(`unknown kind ${JSON.stringify(kind)}`);
      if (!SURFACE_SHOWS.includes(shows))
        refuse(`unknown shows ${JSON.stringify(shows)}`);
      const strange = Object.keys(surface).filter((key) => !KEYS.includes(key));
      if (strange.length) refuse(`unknown key ${strange.join(", ")}`);
      return Object.freeze({ id, slot, kind, shows });
    }),
  );
}
