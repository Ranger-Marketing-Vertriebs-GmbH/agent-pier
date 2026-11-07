import { createContext } from "react";

/**
 * Opens the agent chat's pinboard (tab on phones, docked panel on desktop) scrolled
 * to a list, or at the top for null: `openPinboard(listId | null)`. Null outside a
 * chat that shows a pinboard, such as a restricted user's chat.
 */
export const PinboardContext = createContext({ openPinboard: null });
