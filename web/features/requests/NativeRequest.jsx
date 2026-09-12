import React, { useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { requestCopy as copy } from "../../lib/i18n/messages/requests.js";
import QuestionFields, { questionAnswers } from "./QuestionFields.jsx";
export default function NativeRequest({ request, updated, openTerminal }) {
  const [drafts, setDrafts] = useState({}),
    [validation, setValidation] = useState("");
  const action = useAsyncAction(),
    pending = request.status === "pending",
    hookTrust = request.presentation === "codexHookTrust",
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
          {hookTrust
            ? copy.hookTrustTitle
            : request.kind === "permission"
              ? copy.permission
              : copy.question}
        </strong>
        <small>{request.source}</small>
      </header>
      {hookTrust && <p>{copy.hookTrustDescription}</p>}
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
                hookTrust
                  ? option.id === "trust"
                    ? copy.hookTrustAllow
                    : copy.hookTrustSkip
                  : option.label
              }
              disabled={action.busy}
              onClick={() => answer({ choice: option.id })}
            >
              {hookTrust
                ? option.id === "trust"
                  ? copy.hookTrustAllow
                  : copy.hookTrustSkip
                : option.label}
              {option.scope && <small>{copy.scopes[option.scope] || option.scope}</small>}
            </button>
          ))}
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const answers = questionAnswers(request.questions || [], drafts);
            if (!answers) {
              setValidation(copy.required);
              return;
            }
            setValidation("");
            answer({ answers });
          }}
        >
          {request.questions?.map((question) => (
            <QuestionFields
              key={question.id}
              question={question}
              value={drafts[question.id]}
              disabled={action.busy}
              onChange={(value) =>
                setDrafts((current) => ({ ...current, [question.id]: value }))
              }
            />
          ))}
          <button className="button primary" disabled={action.busy}>
            {copy.answer}
          </button>
        </form>
      )}
      <ErrorMessage error={validation || action.error} />
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
