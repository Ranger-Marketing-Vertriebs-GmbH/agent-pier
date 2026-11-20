import { mediaQueries } from "../../lib/breakpoints.js";

// Where the update notice sits on a phone (AGENTPIER-420). A settings-like page
// (SettingsShell: Inbox, Settings, Projects, Agents, Craft Anything, …) brings its own
// header with the menu or back button, title and tabs; the notice goes right below it,
// so it never covers a header control. Other pages keep the CSS placement below the
// app's phone header (update-notice.css).
const gap = 8;

/** The notice's `top` in px below the page's own header, or null for the CSS default. */
export function noticeTop(doc = document, win = window) {
  if (!win.matchMedia(mediaQueries.phone).matches) return null;
  const header = [...doc.querySelectorAll(".settings-shell-header")].find(
    (element) => element.getClientRects().length > 0,
  );
  if (!header) return null;
  const bottom = header.getBoundingClientRect().bottom;
  return bottom > 0 ? Math.round(bottom + gap) : null;
}
