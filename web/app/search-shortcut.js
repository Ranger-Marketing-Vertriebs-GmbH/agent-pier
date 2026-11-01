// ⌘K (macOS) / Ctrl+K (others) opens the search (handoff §5.9, AGENTPIER-224).
//
// On macOS ⌘K opens it everywhere, the terminal, the code editor and text fields
// included: the Command key types nothing there (xterm sends no input for ⌘ chords,
// CodeMirror and text fields bind no ⌘K), so nothing is taken from them.
// Elsewhere Ctrl+K belongs to the place that has the focus where typing owns the keys:
// in a terminal (xterm) it is readline's kill-line, in the code editor (CodeMirror) and
// in fields that take text it edits too. There the search opens from its buttons. The
// search's own field (`data-search-input`) is no such place.

export function isMacPlatform(browser = globalThis.navigator) {
  const platform = browser?.userAgentData?.platform || browser?.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const typingAreas = ".xterm, .cm-editor";
// Input types that take no text, so the shortcut still works on them.
const nonTextInputs = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Whether typing at `target` owns the shortcut (terminal, editor, text field). */
export function ownsShortcut(target) {
  if (!target || typeof target.closest !== "function") return false;
  if (target.closest("[data-search-input]")) return false;
  if (target.closest(typingAreas)) return true;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target.tagName !== "INPUT") return false;
  return !nonTextInputs.has(String(target.type || "text").toLowerCase());
}

// The K key on any layout: its character, or its position when the layout has no
// Latin letter there.
const isK = (event) => {
  const key = String(event.key || "");
  if (/^[a-z]$/i.test(key)) return key.toLowerCase() === "k";
  return event.code === "KeyK";
};

/** Whether a keydown is the search shortcut for this platform. */
export function isSearchShortcut(event, mac) {
  if (!isK(event) || event.altKey || event.shiftKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Whether a keydown opens the search: the shortcut not handled yet; on macOS anywhere,
 * elsewhere outside typing areas.
 */
export function opensSearch(event, mac) {
  return (
    !event.defaultPrevented &&
    isSearchShortcut(event, mac) &&
    (mac || !ownsShortcut(event.target))
  );
}
