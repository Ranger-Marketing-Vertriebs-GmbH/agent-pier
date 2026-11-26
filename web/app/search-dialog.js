import { createContext, useContext } from "react";

// The ⌘K search (handoff §5.9) opens from the sidebar search button, the phone menu's
// search row and the shortcut. AppSearch.jsx provides `SearchDialogContext`; outside
// it, `open()` announces the request as a window event AppSearch also listens for.
// `open(opener)` names the clicked button that gets the focus back when the search
// closes: Safari on macOS does not focus a button on click.
export const openSearchEvent = "agentpier:open-search";

export const announceSearch = (opener) => {
  try {
    window.dispatchEvent(new CustomEvent(openSearchEvent, { detail: { opener } }));
  } catch {
    // No window (tests, server rendering): nothing to open.
  }
};

export const SearchDialogContext = createContext({ open: announceSearch });

/**
 * The element an `open(from)` call names, or the opener in an open event's detail;
 * null for the shortcut or an event without one, so the focused element takes the
 * focus back.
 */
export function searchOpener(from) {
  const element = from instanceof Event ? from.detail?.opener : from;
  return typeof HTMLElement !== "undefined" && element instanceof HTMLElement
    ? element
    : null;
}

/** `{ open(opener?) }` of the app's search dialog. */
export default function useSearchDialog() {
  return useContext(SearchDialogContext);
}
