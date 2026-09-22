import React from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { requestCopy as copy } from "../../lib/i18n/messages/requests.js";
import QuestionDialog from "./QuestionDialog.jsx";
import { touchRequest } from "./request-interaction.js";
export default function NativeRequest({ request, updated, openTerminal }) {
  const action = useAsyncAction(),
    pending = request.status === "pending",
    // After an uncertain delivery the answer may not have arrived; the
    // terminal is the only safe way on, so keep the handoff reachable.
    releasable = pending || (request.status === "unknown" && request.source === "claude"),
    hookTrust = request.presentation === "codexHookTrust",
    folderTrust = request.presentation === "claudeFolderTrust",
    legacyQuestion = request.presentation === "claudeLegacyQuestion",
    startup = request.presentation === "claudeStartupPrompt",
    startupCopy = startup
      ? copy.startup[request.subject?.dialog] || copy.startup.unknown
      : null,
    optionLabel = (option) =>
      folderTrust
        ? option.id === "trust"
          ? copy.folderTrustAllow
          : copy.folderTrustExit
        : hookTrust
          ? option.id === "trust"
            ? copy.hookTrustAllow
            : copy.hookTrustSkip
          : (startup && copy.startupOptions[request.subject?.dialog]?.[option.id]) ||
            option.label,
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
              : startup
                ? startupCopy.title
                : request.kind === "permission" && !legacyQuestion
                  ? copy.permission
                  : copy.question}
        </strong>
        <small>{request.source}</small>
      </header>
      {hookTrust && <p>{copy.hookTrustDescription}</p>}
      {folderTrust && <p>{copy.folderTrustDescription}</p>}
      {startup && <p>{startupCopy.description}</p>}
      {request.subject && !startup && (
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
      ) : legacyQuestion ? (
        <p role="status">{copy.legacyQuestion}</p>
      ) : request.kind === "permission" && request.options?.length ? (
        <div className="native-request-actions">
          {request.options?.map((option) => (
            <button
              type="button"
              className="button secondary"
              key={option.id}
              aria-label={optionLabel(option)}
              disabled={action.busy}
              onClick={() => answer({ choice: option.id })}
            >
              {optionLabel(option)}
              {option.scope && <small>{copy.scopes[option.scope] || option.scope}</small>}
            </button>
          ))}
        </div>
      ) : null}
      {request.kind === "question" && (
        <div hidden={!pending}>
          <QuestionDialog
            questions={request.questions || []}
            busy={action.busy || !pending}
            answer={answer}
            declinable={request.declinable === true}
            onInteract={() => pending && touchRequest(request)}
          />
        </div>
      )}
      <ErrorMessage error={action.error} />
      <div className="native-request-actions">
        {releasable && !startup && (
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
