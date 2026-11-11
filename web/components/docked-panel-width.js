// The width of a resizable DockedPanel (docs/ui-guide.md#page-structure): pure bounds
// and the per-browser memory. Storage may be missing or throw (private windows,
// blocked site data); the panel then simply starts at its default width.

/** The default and smallest width; matches `--docked-panel-width` in docked-panel.css. */
export const DOCKED_PANEL_WIDTH = 380;
/** The width the content beside the panel always keeps. */
export const DOCKED_CONTENT_MIN = 360;
/** One arrow key press. */
export const DOCKED_PANEL_STEP = 24;

/** The width range in a parent `parentWidth` pixels wide; never below the default. */
export function widthBounds(parentWidth) {
  const min = DOCKED_PANEL_WIDTH;
  const room = Number.isFinite(parentWidth) ? parentWidth - DOCKED_CONTENT_MIN : min;
  return { min, max: Math.max(min, Math.round(room)) };
}

export function clampWidth(width, bounds) {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

const storageKey = (key) => `agentpier-docked-panel-width:${key}`;

export function readStoredWidth(key) {
  try {
    const value = Number(globalThis.localStorage?.getItem(storageKey(key)));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Stores `width`, or forgets it for `null` (back to the default). */
export function storeWidth(key, width) {
  try {
    if (width === null) globalThis.localStorage?.removeItem(storageKey(key));
    else globalThis.localStorage?.setItem(storageKey(key), String(Math.round(width)));
  } catch {
    // Not remembered; the width still applies until the page is left.
  }
}
