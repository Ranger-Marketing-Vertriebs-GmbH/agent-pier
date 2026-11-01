// A field a person types into: a text input, a text area, a select or editable text.
const textField = (node) =>
  Boolean(node) &&
  (["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName) ||
    node.isContentEditable === true);

/**
 * Whether the terminal takes the focus after a render. It does on mount and on a mode
 * change while its view is the focused one. When its split view pane has just become
 * the focused one (`gained`), it leaves a field in the same pane's chrome focused: the
 * click that focused the pane went there, not to the terminal. In a split view a
 * terminal that mounts late never takes the focus from a field outside it (the view's
 * name, another pane's composer) while someone may be typing there.
 */
export function takesFocus({ mode, autoFocus, gained, active, body, mount }) {
  if (!autoFocus || mode !== "terminal") return false;
  if (!active || active === body) return true;
  if (mount?.contains(active)) return true;
  if (mount?.closest(".in-pane") && textField(active)) return false;
  if (!gained) return true;
  if (!mount) return false;
  const workspace = mount.closest(".session-workspace");
  return !workspace?.contains(active);
}
