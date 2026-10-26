import { createContext, useContext } from "react";

// The ⌘K search (handoff §5.9) opens from the sidebar search button, the phone menu's
// search row and the shortcut. AppSearch.jsx provides `SearchDialogContext`; outside
// it, `open()` announces the request as a window event AppSearch also listens for.
export const openSearchEvent = "agentpier:open-search";

export const announceSearch = () => {
  try {
    window.dispatchEvent(new CustomEvent(openSearchEvent));
  } catch {
    // No window (tests, server rendering): nothing to open.
  }
};

export const SearchDialogContext = createContext({ open: announceSearch });

/** `{ open() }` of the app's search dialog. */
export default function useSearchDialog() {
  return useContext(SearchDialogContext);
}
