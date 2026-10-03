import React, { useEffect, useState } from "react";
import useResource from "../../lib/useResource.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { requestCopy as copy } from "../../lib/i18n/messages/requests.js";
import NativeRequest from "./NativeRequest.jsx";
import { noticeSettled, settleNotice } from "./request-interaction.js";
import "./requests.css";
export default function RequestPanel({ session, active, openTerminal, onStateChange }) {
  const resource = useResource(
    active ? `/sessions/${encodeURIComponent(session.id)}/requests` : null,
    { poll: 1500 },
  );
  const [, setSettled] = useState(0);
  const blocked =
    resource.loading ||
    Boolean(resource.error) ||
    Boolean(resource.data?.requests.length);
  useEffect(() => {
    onStateChange?.({ sessionId: session.id, blocked });
  }, [session.id, blocked, onStateChange]);
  const reloadRequired = resource.data?.integration?.reloadRequired;
  // An approval that left chat for Claude's own dialog is announced, never
  // silently dropped. It is informational only and does not block chat.
  const notice = resource.data?.notice;
  const showNotice = Boolean(notice?.id && !noticeSettled(notice.id));
  const settle = () => {
    settleNotice(notice.id);
    setSettled((value) => value + 1);
  };
  if (
    !resource.error &&
    !resource.data?.requests.length &&
    !reloadRequired &&
    !showNotice
  )
    return null;
  return (
    <section className="native-requests" aria-label={copy.title}>
      <ErrorMessage error={resource.error} />
      {resource.data?.requests.map((request) => (
        <NativeRequest
          key={request.id}
          request={request}
          updated={resource.update}
          openTerminal={openTerminal}
        />
      ))}
      {showNotice && (
        <div className="native-request">
          <p role="status">{copy.terminalApproval}</p>
          <div className="native-request-actions">
            <button
              type="button"
              className="button secondary compact"
              onClick={() => {
                settle();
                openTerminal();
              }}
            >
              {copy.terminal}
            </button>
            <button type="button" className="button secondary compact" onClick={settle}>
              {copy.dismissNotice}
            </button>
          </div>
        </div>
      )}
      {reloadRequired && (
        <div className="native-request">
          <p role="status">{copy.reloadRequired}</p>
          <code>/reload-plugins</code>
          <div className="native-request-actions">
            <button
              type="button"
              className="button secondary compact"
              onClick={openTerminal}
            >
              {copy.terminal}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
