import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import api from "../../lib/api.js";
import { launchDialogCopy as copy } from "../../lib/i18n/messages/sessions.js";
import useAsyncAction from "../../lib/useAsyncAction.js";

/** The sign-in session id of a start the open sign-in refused, or null. */
export const signInOf = (error) =>
  error?.code === "SESSION_LOGIN_OPEN" && typeof error.sessionId === "string"
    ? error.sessionId
    : null;

/**
 * A start refused because the account's sign-in session is still open (the refusal
 * names it): stop that session here, then start again.
 */
export default function StopSignIn({ sessionId, onStopped }) {
  const { busy, error, run } = useAsyncAction();
  return (
    <div className="launch-sign-in-open">
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={() =>
          run(async () => {
            await api(`/sessions/${encodeURIComponent(sessionId)}/stop`, "POST");
            onStopped();
          })
        }
      >
        {busy ? copy.stoppingSignIn : copy.stopSignIn}
      </button>
      <ErrorMessage error={error} />
    </div>
  );
}
