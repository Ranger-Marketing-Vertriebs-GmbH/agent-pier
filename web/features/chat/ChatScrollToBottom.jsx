import React, { useLayoutEffect, useState } from "react";
import { chatViewCopy as copy } from "../../lib/i18n/messages/chat.js";

export default function ChatScrollToBottom({ active, output, stick, scroll }) {
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
    const element = output.current;
    if (!active || !element) {
      setVisible(false);
      return;
    }
    const update = () =>
      setVisible(element.scrollHeight - element.scrollTop - element.clientHeight > 160);
    update();
    element.addEventListener("scroll", update);
    const resize = new ResizeObserver(update);
    resize.observe(element);
    const changes = new MutationObserver(update);
    changes.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      element.removeEventListener("scroll", update);
      resize.disconnect();
      changes.disconnect();
    };
  }, [active, output]);
  if (!visible) return null;
  return (
    <button
      type="button"
      className="chat-jump-bottom"
      onClick={() => {
        const element = output.current;
        if (!element) return;
        stick.current = true;
        element.scrollTop = element.scrollHeight;
        scroll.current = element.scrollTop;
        setVisible(false);
      }}
    >
      <span aria-hidden="true">↓</span> {copy.jumpToLatest}
    </button>
  );
}
