import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import Icon from "../../components/Icon.jsx";
import { dictationCopy as copy } from "../../lib/i18n/messages/dictation.js";
import useDictation, { browserReason, useDictationStatus } from "./useDictation.js";
import "./dictation.css";
import { connectionsRoute, connectionsRoutePath } from "../connections/routes.js";

const setupHref = connectionsRoutePath(connectionsRoute("services", "speech"));

function noticeText(notice) {
  if (!notice) return "";
  if (notice.kind === "status") return copy[notice.code] || "";
  if (notice.kind === "error")
    return copy.errors[notice.code] || copy.reasons[notice.code] || copy.errors.failed;
  if (notice.code === "stopped") return copy.stopped;
  if (notice.code === "limit")
    return copy.ended.limit(Math.round((notice.maxSeconds || 300) / 60));
  return copy.ended[notice.code] || copy.stopped;
}

/**
 * The composers' microphone (AssistantComposer, ChatComposer): tap to dictate, the
 * words appear live in the field, tap again to stop. The text stays for editing
 * unless the speech settings send it right away. Unavailable dictation explains
 * itself (no key, no agents, plain HTTP) instead of hiding.
 */
export default function DictationButton({ text, onText, disabled = false }) {
  const status = useDictationStatus();
  const button = useRef(null);
  const hintId = useId();
  const hintBox = useRef(null);
  const [hintOpen, setHintOpen] = useState(false);
  const [submitText, setSubmitText] = useState(null);
  const dictation = useDictation({
    text,
    onText,
    onFinished: (value) => status?.autoSend && setSubmitText(value),
  });
  const { phase, level, notice, start, stop, dismiss } = dictation;
  const reason = browserReason() || (status && !status.available && status.reason);
  const active = phase !== "idle";
  // The field or its chat closed meanwhile (a stopped session, a delivery).
  useEffect(() => {
    if (disabled && active) stop();
  }, [disabled, active, stop]);
  // Sends once React has written the final text into the field.
  useEffect(() => {
    if (submitText === null) return;
    setSubmitText(null);
    if (text === submitText) button.current?.form?.requestSubmit();
  }, [submitText, text]);
  const shown = notice && notice.kind !== "status" ? noticeText(notice) : "";
  const hint = reason && hintOpen ? copy.reasons[reason] || copy.reasons.unknown : shown;
  const close = () => {
    setHintOpen(false);
    dismiss();
  };
  // The hint opens above the button; on a phone it shifts to stay on screen.
  useLayoutEffect(() => {
    const element = hintBox.current;
    if (!element) return;
    element.style.translate = "";
    const box = element.getBoundingClientRect();
    const margin = 16;
    const right = document.documentElement.clientWidth - margin;
    const shift =
      box.left < margin ? margin - box.left : box.right > right ? right - box.right : 0;
    if (shift) element.style.translate = `${Math.round(shift)}px 0`;
  }, [hint]);
  const label = active ? copy.stop : reason ? copy.unavailable : copy.start;
  return (
    <span
      className={`dictation${active ? " active" : ""}${phase === "recording" ? " recording" : ""}`}
      style={{ "--dictation-level": level.toFixed(2) }}
    >
      <button
        ref={button}
        type="button"
        className="dictation-button"
        aria-label={label}
        title={label}
        aria-pressed={active}
        aria-disabled={reason || !status ? true : undefined}
        aria-describedby={hint ? hintId : undefined}
        disabled={disabled && !active}
        onClick={() => {
          if (active) return stop();
          if (reason) return setHintOpen((open) => !open);
          if (!status) return;
          dismiss();
          start();
        }}
      >
        <Icon name={active ? "stop" : "mic"} size={active ? 13 : 18} fill={active} />
      </button>
      {hint && (
        <span ref={hintBox} className="dictation-hint" id={hintId}>
          <span>{hint}</span>
          {hintOpen && ["notConfigured", "unknown"].includes(reason) && (
            <a href={setupHref}>{copy.setup}</a>
          )}
          {notice?.kind === "error" &&
            ["auth", "quota", "notConfigured"].includes(notice.code) && (
              <a href={setupHref}>{copy.setup}</a>
            )}
          <button
            type="button"
            className="dictation-hint-close"
            aria-label={copy.close}
            onClick={close}
          >
            <Icon name="close" size={13} />
          </button>
        </span>
      )}
      <span className="sr-only" role="status">
        {noticeText(notice)}
      </span>
    </span>
  );
}
