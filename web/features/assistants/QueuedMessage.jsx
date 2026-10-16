import React, { useLayoutEffect, useRef } from "react";
import Icon from "../../components/Icon.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { serverProblemText } from "../../lib/server-messages.js";
import { queuedNotice } from "./queued-message.js";
import "./assistant-queue.css";

const noticeText = (kind, queued, name) =>
  kind === "sending"
    ? copy.queued.sending
    : kind === "failed"
      ? copy.queued.failed(serverProblemText(queued, copy.queued.unknownError))
      : kind === "blocked"
        ? copy.queued.blocked(name)
        : kind === "retrying"
          ? copy.queued.retrying(name)
          : copy.queued.notice(name);

// The message queued while the agent works, above the field: what waits, for whom,
// and Edit to take it back (not while it is on its way). The notice is announced by
// a live region that stays in place; focus on Edit moves to the field when the card
// or its Edit button goes.
export default function QueuedMessage({
  queued,
  name,
  active,
  available,
  field,
  onTakeBack,
}) {
  const kind = queuedNotice(queued, { active, available });
  const editing = useRef(false);
  const editable = Boolean(queued) && kind !== "sending";
  useLayoutEffect(() => {
    if (editable || !editing.current) return;
    editing.current = false;
    field.current?.focus();
  }, [editable, field]);
  const notice = kind ? noticeText(kind, queued, name) : "";
  // The service coming and going changes the card, not what is announced.
  const announced = kind
    ? noticeText(kind === "blocked" ? "waiting" : kind, queued, name)
    : "";
  return (
    <>
      {/* role="status" is polite by itself; the chat keeps one explicit region for replies. */}
      <span className="sr-only assistant-queued-live" role="status">
        {announced}
      </span>
      {queued && (
        <div
          className={`assistant-queued ${kind}`}
          role="group"
          aria-label={copy.queued.label}
        >
          <div className="assistant-queued-body">
            <span className="assistant-queued-notice">
              <Icon name="history" size={13} />
              {notice}
            </span>
            {queued.text && <p className="assistant-queued-text">{queued.text}</p>}
            {queued.attachments?.length > 0 && (
              <span className="assistant-queued-files">
                {copy.queued.files(queued.attachments.length)}
              </span>
            )}
          </div>
          {editable && (
            <button
              type="button"
              className="assistant-queued-edit"
              aria-label={copy.queued.editLabel}
              onFocus={() => (editing.current = true)}
              onBlur={() => (editing.current = false)}
              onClick={() => {
                field.current?.focus();
                onTakeBack();
              }}
            >
              {copy.queued.edit}
            </button>
          )}
        </div>
      )}
    </>
  );
}
