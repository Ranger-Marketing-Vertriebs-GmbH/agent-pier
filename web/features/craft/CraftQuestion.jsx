import React, { useId, useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { craftCopy } from "../../lib/i18n/messages/craft.js";
import "./craft-question.css";

// Refusals that mean the question no longer waits: answered elsewhere (the inbox, the
// Rebuilds page, auto mode) or its rebuild is gone.
const goneKeys = new Set(["craft.rebuildQuestionGone", "craft.rebuildNotFound"]);

/** Whether an answer was refused because the question no longer waits. */
export const answerGone = (error) =>
  error?.status === 404 || (error?.status === 409 && goneKeys.has(error.messageKey));

/**
 * One open question or approval of a Craft Anything rebuild (RebuildView `questions`),
 * answered through POST /api/craft/rebuilds/:id/answer: a question by one of its
 * choices or, where it allows text, in the owner's words; an approval by Allow,
 * Always allow or Deny. `onAnswered(view)` hears the rebuild after the answer,
 * `onGone()` that the question was answered elsewhere in the meantime.
 */
export default function CraftQuestion({ rebuildId, question, onAnswered, onGone }) {
  const copy = craftCopy.question;
  const action = useAsyncAction();
  const [text, setText] = useState("");
  const titleId = useId();
  const textId = useId();
  const approval = question.kind === "approval";
  const choices = Array.isArray(question.choices) ? question.choices : [];
  const answer = (body) =>
    action.run(async () => {
      let view;
      try {
        view = await api(
          `/craft/rebuilds/${encodeURIComponent(rebuildId)}/answer`,
          "POST",
          { questionId: question.id, ...body },
        );
      } catch (error) {
        if (onGone && answerGone(error)) return onGone();
        throw error;
      }
      await onAnswered?.(view);
    });
  const submit = (event) => {
    event.preventDefault();
    if (text.trim()) answer({ text });
  };
  return (
    <article className="craft-question" aria-labelledby={titleId}>
      <header>
        <small>{approval ? copy.approval : copy.question}</small>
        <strong id={titleId} dir="auto">
          {question.title}
        </strong>
      </header>
      {question.detail && (
        <p className="craft-question-detail" dir="auto">
          {question.detail}
        </p>
      )}
      {approval && question.action && (
        <pre aria-label={copy.action} dir="auto">
          {question.action}
        </pre>
      )}
      {approval ? (
        <div className="craft-question-actions">
          <button
            type="button"
            className="button primary"
            disabled={action.busy}
            onClick={() => answer({ allow: true })}
          >
            {copy.allow}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={action.busy}
            onClick={() => answer({ allow: true, always: true })}
          >
            {copy.allowAlways}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={action.busy}
            onClick={() => answer({ allow: false })}
          >
            {copy.deny}
          </button>
        </div>
      ) : (
        <>
          {choices.length > 0 && (
            <div
              className="craft-question-actions"
              role="group"
              aria-label={copy.choicesLabel}
            >
              {choices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className="button secondary"
                  dir="auto"
                  disabled={action.busy}
                  onClick={() => answer({ choice })}
                >
                  {choice}
                </button>
              ))}
            </div>
          )}
          {(question.allowText || !choices.length) && (
            <form className="craft-question-text" onSubmit={submit}>
              <label htmlFor={textId}>{copy.textLabel}</label>
              <textarea
                id={textId}
                dir="auto"
                rows={3}
                required
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <div className="craft-question-actions">
                <button type="submit" className="button primary" disabled={action.busy}>
                  {action.busy ? copy.sending : copy.send}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      <ErrorMessage error={action.error} />
    </article>
  );
}
