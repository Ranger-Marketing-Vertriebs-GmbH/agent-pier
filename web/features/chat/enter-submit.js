import { commonCopy } from "../../lib/i18n/messages/common.js";
import { chatComposerCopy } from "../../lib/i18n/messages/chat.js";

// Enter sends and Shift+Enter breaks the line, except while composing text (IME),
// with other modifiers, or on touch input where Enter always breaks the line.
export function shouldSubmitOnEnter(event, touchInput) {
  return !(
    event.key !== "Enter" ||
    event.nativeEvent.isComposing ||
    event.keyCode === 229 ||
    touchInput ||
    event.shiftKey ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  );
}

export const enterKeyHint = (touchInput) => (touchInput ? "enter" : "send");

export const sendHint = (touchInput) =>
  touchInput ? chatComposerCopy.touchSendHint : commonCopy.desktopSendHint;
