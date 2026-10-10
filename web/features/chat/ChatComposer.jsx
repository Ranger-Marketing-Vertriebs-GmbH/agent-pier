import { commonCopy } from "../../lib/i18n/messages/common.js";
import { chatComposerCopy as copy } from "../../lib/i18n/messages/chat.js";
import { providerNames } from "./presentation.js";
import React, { useEffect, useLayoutEffect, useRef } from "react";
import SlashCompletion from "./SlashCompletion.jsx";
import useSlashCompletion from "./useSlashCompletion.js";
import ChatAttachments from "./ChatAttachments.jsx";
import { enterKeyHint, sendHint, shouldSubmitOnEnter } from "./enter-submit.js";
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
  const sendButton = useRef(null);
  const restoreFocus = useRef(false);
  const locked = busy || deliveryLocked;
  const completion = useSlashCompletion({
    session,
    text,
    setText,
    setSent,
    input,
    disabled:
      busy ||
      deliveryLocked ||
      modelPending ||
      session.pipeline?.headless ||
      session.status !== "running" ||
      session.purpose === "login",
  });
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
  // Delivery only makes the field read-only, so Enter keeps focus. If the focus
  // still rests on the composer area when the lock lifts, hand it back.
  useEffect(() => {
    if (locked || !restoreFocus.current) return;
    restoreFocus.current = false;
    const active = document.activeElement;
    const idle = !active || active === document.body || active === sendButton.current;
    const compact = touchInput || window.matchMedia("(max-width: 700px)").matches;
    if (idle && !compact && input.current && !input.current.disabled)
      input.current.focus({ preventScroll: true });
  }, [locked, touchInput]);
  const submitForm = (event) => {
    const active = document.activeElement;
    restoreFocus.current =
      !active ||
      active === document.body ||
      active === input.current ||
      active === sendButton.current;
    return submit(event);
  };
  return (
    <form className="composer chat-composer" onSubmit={submitForm}>
      <SlashCompletion completion={completion} />
      <ChatAttachments
        {...attachments}
        disabled={
          deliveryLocked ||
          session.pipeline?.headless ||
          session.status !== "running" ||
          session.purpose === "login" ||
          busy ||
          modelPending
        }
      />
      <textarea
        ref={input}
        aria-autocomplete="list"
        aria-controls={completion.open ? completion.id : undefined}
        aria-activedescendant={
          completion.open ? `${completion.id}-${completion.selected}` : undefined
        }
        onFocus={completion.onFocus}
        onBlur={completion.onBlur}
        aria-label={commonCopy.message}
        placeholder={commonCopy.messagePlaceholder(providerNames[session.tool])}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setSent(false);
        }}
        readOnly={locked}
        aria-busy={locked || undefined}
        disabled={session.pipeline?.headless || session.status !== "running"}
        maxLength={32000}
        rows={1}
        enterKeyHint={enterKeyHint(touchInput)}
        onPaste={(event) => {
          if (!event.clipboardData.files.length) return;
          event.preventDefault();
          if (!locked && !modelPending) attachments.add(event.clipboardData.files);
        }}
        onKeyDown={(event) => {
          if (completion.onKeyDown(event)) return;
          if (!shouldSubmitOnEnter(event, touchInput)) return;
          event.preventDefault();
          if (!event.repeat) submitForm(event);
        }}
      />
      <div className="chat-compose-actions">
        <span className={`chat-send-hint${requestPending || sent ? " has-status" : ""}`}>
          {requestPending
            ? copy.requestPending
            : sent
              ? copy.messageSent
              : sendHint(touchInput)}
        </span>
        <button
          ref={sendButton}
          className="button primary chat-send"
          aria-label={busy ? commonCopy.sending : commonCopy.send}
          disabled={
            deliveryLocked ||
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
