// Codex, Claude and OpenCode accept Alt+Enter as a newline. Its legacy encoding
// survives tmux without extended-key negotiation; CSI-u Shift+Enter becomes CR.
export const shiftEnter = "\u001b\r";

export function terminalKey(event) {
  if (
    event?.type !== "keydown" ||
    event.key !== "Enter" ||
    !event.shiftKey ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.isComposing
  )
    return null;
  return shiftEnter;
}
