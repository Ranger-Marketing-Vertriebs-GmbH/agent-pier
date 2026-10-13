/** A plain primary click: in-app navigation; modified clicks keep browser behaviour. */
export const isPlainClick = (event) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;
