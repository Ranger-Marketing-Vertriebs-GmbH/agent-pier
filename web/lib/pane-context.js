import { createContext, useContext } from "react";

// The pane a hosted view renders in, or null for today's single view. A view mounted
// several times at once reads its size, focus and id prefix from here; outside a
// pane every consumer keeps its single-view behaviour and element ids.
// Value: { key, focused, width, height, idPrefix }.
export const PaneContext = createContext(null);

export const usePane = () => useContext(PaneContext);

/** `base` outside a pane, else the id prefixed with the pane's own prefix. */
export const paneId = (pane, base) => (pane ? `${pane.idPrefix}-${base}` : base);

export const usePaneId = (base) => paneId(usePane(), base);
