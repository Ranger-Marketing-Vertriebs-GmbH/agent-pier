// Kitty keyboard protocol: CSI 13;2u represents Shift+Enter and lets TUIs
// distinguish a newline from submitting the current prompt.
export const shiftEnter = "\u001b[13;2u";

export function terminalKey(event) {
  return event?.type === "keydown" && event.key === "Enter" && event.shiftKey
    ? shiftEnter
    : null;
}
