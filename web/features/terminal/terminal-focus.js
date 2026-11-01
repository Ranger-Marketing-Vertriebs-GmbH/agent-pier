/**
 * Whether the terminal takes the focus after a render. It does on mount and on a mode
 * change while its view is the focused one. When its split view pane has just become
 * the focused one (`gained`), it leaves a field in the same pane's chrome focused: the
 * click that focused the pane went there, not to the terminal.
 */
export function takesFocus({ mode, autoFocus, gained, active, body, mount }) {
  if (!autoFocus || mode !== "terminal") return false;
  if (!gained || !active || active === body) return true;
  if (!mount) return false;
  if (mount.contains(active)) return true;
  const workspace = mount.closest(".session-workspace");
  return !workspace?.contains(active);
}
