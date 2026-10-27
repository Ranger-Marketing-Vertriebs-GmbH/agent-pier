import React from "react";
import useResource from "../../lib/useResource.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantWorkflowCopy as copy } from "../../lib/i18n/messages/assistant-workflows.js";
import NativeRequest from "../requests/NativeRequest.jsx";

/**
 * A prompt of an agent's coding session that the agent escalated to the owner
 * (payload `session_request`): the live prompt as the session's chat shows it,
 * answered through the session's own request endpoint, or "Answered" once it is
 * gone. The action itself leaves the chat on the next tick.
 */
export default function SessionRequestEscalationCard({ action, agentName, onNavigate }) {
  const { sessionId, promptId, sessionName, note } = action.payload;
  const resource = useResource(`/sessions/${encodeURIComponent(sessionId)}/requests`, {
    poll: 1500,
  });
  const request = resource.data?.requests?.find((entry) => entry.id === promptId);
  const open = (mode) => onNavigate?.({ view: "workspace", sessionId, mode });
  return (
    <article
      className="assistant-approval-card"
      data-pending=""
      data-session-escalation=""
    >
      <div className="assistant-approval-head">
        <strong>{copy.escalation.title}</strong>
        {sessionName && <small>{sessionName}</small>}
      </div>
      {note && (
        <>
          <strong className="assistant-approval-title">
            {copy.escalation.note(agentName || "")}
          </strong>
          <p className="assistant-approval-task">{note}</p>
        </>
      )}
      {resource.error && !resource.data && <ErrorMessage error={resource.error} />}
      {request ? (
        <section className="native-requests">
          <NativeRequest
            request={request}
            updated={resource.update}
            openTerminal={() => open("terminal")}
          />
        </section>
      ) : (
        resource.data && <p className="assistant-note">{copy.escalation.answered}</p>
      )}
      {onNavigate && (
        <div className="assistant-card-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => open("reader")}
          >
            {copy.escalation.openSession}
          </button>
        </div>
      )}
    </article>
  );
}
