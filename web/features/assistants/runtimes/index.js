import hermes from "./hermes/index.js";
import openclaw from "./openclaw/index.js";

// The web descriptors of the runtimes that register UI of their own
// (docs/adr/0007-runtime-descriptor.md), by runtime id: `{ id, surfaces:
// { [surfaceId]: Component }, search }`. Product code outside this folder names no
// runtime; it asks here (RuntimeSlot.jsx). A runtime without a surface has no entry.
// search.js beside this lists the same runtimes' search entries without their
// components; tests/unit/runtime-surfaces.test.js keeps both and the server's
// descriptors in step.
const registered = Object.freeze({ [hermes.id]: hermes, [openclaw.id]: openclaw });

/** Every web descriptor. */
export const webRuntimes = Object.freeze(Object.values(registered));

/** The web descriptor of runtime `id`, or undefined when it registers no UI. */
export const webRuntime = (id) =>
  typeof id === "string" && Object.hasOwn(registered, id) ? registered[id] : undefined;
