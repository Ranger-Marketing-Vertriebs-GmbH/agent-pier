// Scrolls a transcript to one of its descendants with scrollTop only. scrollIntoView
// would also scroll the fixed page on iOS while the keyboard is open.
export function scrollToChild(container, element, offset = 12) {
  if (!container || !element) return false;
  const top =
    element.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop -
    offset;
  container.scrollTop = Math.max(0, top);
  return true;
}
