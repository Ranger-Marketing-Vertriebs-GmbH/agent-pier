import { commonCopy } from "../../lib/i18n/de/common.js";
import { chatComposerCopy as copy } from "../../lib/i18n/de/chat.js";
import { providerNames } from "./presentation.js";
import React, { useLayoutEffect, useRef } from "react";
import ChatAttachments from "./ChatAttachments.jsx";
export default function ChatComposer({
  submit,
  session,
  text,
  setText,
  setSent,
  touchInput,
  sent,
  busy,
  modelPending,
  requestPending = false,
  deliveryLocked = false,
  attachments,
}) {
  const input = useRef(null);
  useLayoutEffect(() => {
    const element = input.current;
    const media = window.matchMedia("(max-width: 700px)");
    const resize = () => {
      element.style.height = "";
      if (media.matches) {
        element.style.height = "auto";
        element.style.height = `${Math.min(element.scrollHeight, 144)}px`;
      }
    };
    resize();
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, [text]);
  return (
    <form className="composer chat-composer" onSubmit={submit}>
      <ChatAttachments
        {...attachments}
        disabled={
          deliveryLocked ||
          requestPending ||
          session.pipeline?.headless ||
          session.status !== "running" ||
          session.purpose === "login" ||
          busy ||
          modelPending
        }
      />
      <textarea
        ref={input}
        aria-label={commonCopy.message}
        placeholder={commonCopy.messagePlaceholder(providerNames[session.tool])}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setSent(false);
        }}
        disabled={
          busy ||
          deliveryLocked ||
          requestPending ||
          session.pipeline?.headless ||
          session.status !== "running"
        }
        maxLength={32000}
        rows={1}
        enterKeyHint={touchInput ? "enter" : "send"}
        onPaste={(event) => {
          if (!event.clipboardData.files.length) return;
          event.preventDefault();
          if (!requestPending && !busy && !modelPending)
            attachments.add(event.clipboardData.files);
        }}
        onKeyDown={(event) => {
          if (
            event.key !== "Enter" ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229 ||
            touchInput ||
            event.shiftKey ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          event.preventDefault();
          if (!event.repeat) submit(event);
        }}
      />
      <div className="chat-compose-actions">
        <span className={`chat-send-hint${requestPending || sent ? " has-status" : ""}`}>
          {requestPending
            ? copy.requestPending
            : sent
              ? copy.messageSent
              : touchInput
                ? copy.touchSendHint
                : commonCopy.desktopSendHint}
        </span>
        <button
          className="button primary chat-send"
          aria-label={busy ? commonCopy.sending : commonCopy.send}
          disabled={
            deliveryLocked ||
            requestPending ||
            session.pipeline?.headless ||
            busy ||
            modelPending ||
            attachments.uploading ||
            attachments.blocked ||
            (!text.trim() && !attachments.attachments.length) ||
            session.status !== "running"
          }
        >
          <span className="chat-send-label">
            {busy ? commonCopy.sending : commonCopy.send}
          </span>{" "}
          <span aria-hidden="true">↑</span>
        </button>
      </div>
    </form>
  );
}
