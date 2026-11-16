// Pure rules of the runtimes' surfaces (docs/adr/0007-runtime-descriptor.md): UI a
// runtime registers at a named slot of a page AgentPier owns. Each entry of the
// runtime list (runtime-list.js) names its runtime's `surfaces`: `[{ id, slot, kind,
// shows }]`, a described one with its `scope` and `fields`, as the server's
// descriptor states them (server runtimes/runtime-surfaces.js). RuntimeSlot.jsx
// renders a slot; the search index lists the built surfaces that show
// (runtime-surface-search.js). No request here.

/**
 * Whether `surface` of the list entry `runtime` shows now: `always`, or
 * `whileEnabled` while a new agent may run on the runtime (`ready`). A rule this
 * build does not know shows nothing.
 */
export const surfaceShows = (runtime, surface) =>
  surface?.shows === "always" ||
  (surface?.shows === "whileEnabled" && runtime?.ready === true);

/**
 * The built surfaces that show, of every slot: `[{ runtime, surface }]`, the runtimes
 * in the list's order and each one's surfaces in its descriptor's.
 */
export const shownSurfaces = (runtimes) =>
  (Array.isArray(runtimes) ? runtimes : []).flatMap((runtime) =>
    (Array.isArray(runtime?.surfaces) ? runtime.surfaces : [])
      .filter((surface) => surface?.kind === "built" && surfaceShows(runtime, surface))
      .map((surface) => ({ runtime, surface })),
  );

/** The built surfaces slot `slot` renders now (shownSurfaces). */
export const slotSurfaces = (runtimes, slot) =>
  shownSurfaces(runtimes).filter(({ surface }) => surface.slot === slot);

// The kinds a slot renders: a built surface with the runtime's component, a
// described one from its fields. A kind this build does not know renders nothing.
const rendered = ["built", "described"];

/**
 * Everything slot `slot` renders now: the built and the described surfaces that
 * show, `[{ runtime, surface }]`, the runtimes in the list's order and each one's
 * surfaces in its descriptor's.
 */
export const slotEntries = (runtimes, slot) =>
  (Array.isArray(runtimes) ? runtimes : []).flatMap((runtime) =>
    (Array.isArray(runtime?.surfaces) ? runtime.surfaces : [])
      .filter(
        (surface) =>
          surface?.slot === slot &&
          rendered.includes(surface.kind) &&
          surfaceShows(runtime, surface),
      )
      .map((surface) => ({ runtime, surface })),
  );

/** A stable key of one shown surface: its runtime's id and its own. */
export const surfaceKey = ({ runtime, surface }) => `${runtime.id}:${surface.id}`;
