import React from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { requestCopy as copy } from "../../lib/i18n/messages/requests.js";
import QuestionDialog from "./QuestionDialog.jsx";
export default function NativeRequest({ request, updated, openTerminal }) {
  const action = useAsyncAction(),
    pending = request.status === "pending",
    hookTrust = request.presentation === "codexHookTrust",
    folderTrust = request.presentation === "claudeFolderTrust",
    base = `/sessions/${encodeURIComponent(request.sessionId)}/requests/${encodeURIComponent(request.id)}`;
  const answer = (body) =>
    action.run(async () => {
      const result = await api(base + "/answer", "POST", {
        expectedRevision: request.revision,
        ...body,
      });
      updated(result);
    });
  return (
    <article className="native-request">
      <header>
        <strong>
          {folderTrust
            ? copy.folderTrustTitle
            : hookTrust
              ? copy.hookTrustTitle
              : request.kind === "permission"
                ? copy.permission
                : copy.question}
        </strong>
        <small>{request.source}</small>
      </header>
      {hookTrust && <p>{copy.hookTrustDescription}</p>}
      {folderTrust && <p>{copy.folderTrustDescription}</p>}
      {request.subject && (
        <div>
          {request.subject.description && <p>{request.subject.description}</p>}
          {(request.subject.command || request.subject.path || request.subject.tool) && (
            <pre aria-label={copy.details}>
              {request.subject.command || request.subject.path || request.subject.tool}
            </pre>
          )}
          {request.subject.cwd && (
            <small>
              {copy.cwd}: {request.subject.cwd}
            </small>
          )}
        </div>
      )}
      {request.status === "unknown" ? (
        <p role="status">{copy.unknown}</p>
      ) : request.status === "responding" ? (
        <p role="status">{copy.responding}</p>
      ) : request.kind === "permission" ? (
        <div className="native-request-actions">
          {request.options?.map((option) => (
            <button
              type="button"
              className="button secondary"
              key={option.id}
              aria-label={
                folderTrust
                  ? option.id === "trust"
                    ? copy.folderTrustAllow
                    : copy.folderTrustExit
                  : hookTrust
                    ? option.id === "trust"
                      ? copy.hookTrustAllow
                      : copy.hookTrustSkip
                    : option.label
              }
              disabled={action.busy}
              onClick={() => answer({ choice: option.id })}
            >
              {folderTrust
                ? option.id === "trust"
                  ? copy.folderTrustAllow
                  : copy.folderTrustExit
                : hookTrust
                  ? option.id === "trust"
                    ? copy.hookTrustAllow
                    : copy.hookTrustSkip
                  : option.label}
              {option.scope && <small>{copy.scopes[option.scope] || option.scope}</small>}
            </button>
          ))}
        </div>
      ) : (
        <QuestionDialog
          questions={request.questions || []}
          busy={action.busy}
          answer={answer}
        />
      )}
      <ErrorMessage error={action.error} />
      <div className="native-request-actions">
        {pending && (
          <button
            type="button"
            className="button secondary compact"
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                const result = await api(base + "/handoff", "POST", {
                  expectedRevision: request.revision,
                });
                updated(result);
                openTerminal();
              })
            }
          >
            {copy.handoff}
          </button>
        )}
        <button type="button" className="button secondary compact" onClick={openTerminal}>
          {copy.terminal}
        </button>
      </div>
    </article>
  );
}
