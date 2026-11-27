import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { assistantWorkflowCopy } from "../../lib/i18n/messages/assistant-workflows.js";
import QuestionFields, { questionAnswers } from "../requests/QuestionFields.jsx";
import "../requests/requests.css";
import { assistantApi } from "./assistant-api.js";

// A question as QuestionFields takes it; an option's id is its position.
const fieldOf = (question) => ({
  id: question.id,
  header: question.header,
  prompt: question.text,
  options: question.options.map((option, index) => ({
    id: String(index),
    label: option.label,
    description: option.description,
  })),
  multiple: question.multiSelect,
  allowOther: question.other,
});

/**
 * The answers of every question from the fields' drafts, as the answer route takes
 * them (`{ <question id>: [option label or own text, …] }`), or null while one
 * question is still open.
 */
export function cardAnswers(fields, drafts) {
  if (!questionAnswers(fields, drafts)) return null;
  return Object.fromEntries(
    fields.map((field) => {
      const draft = drafts[field.id] || {};
      const labels = (draft.selected || []).map((id) => field.options[Number(id)].label);
      const own = draft.other || !field.options.length ? (draft.text || "").trim() : "";
      return [field.id, own && !labels.includes(own) ? [...labels, own] : labels];
    }),
  );
}

/**
 * A request the agent waits on in this chat (server agent-questions.js): one to
 * three questions. A single question with plain options shows them as buttons, one
 * click answers it, beside a field for an answer of the owner's own; several
 * questions, a multiple choice or options with a description show as a form that is
 * sent in one piece. The answers go back to the agent's turn; the card leaves once
 * the feed no longer lists it. The inbox shows the same card and reads its list again
 * after an answer (`onAnswered`).
 */
export default function QuestionCard({ conversationId, question, onAnswered }) {
  const copy = assistantWorkflowCopy.question;
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [first] = question.questions;
  const quick =
    question.questions.length === 1 &&
    !first.multiSelect &&
    !first.options.some((option) => option.description);
  async function send(answers) {
    setBusy(true);
    setError(null);
    try {
      await assistantApi.answerQuestion(conversationId, question.id, answers);
      setText("");
      onAnswered?.();
    } catch (failure) {
      // The server names why (the agent no longer waits), translated.
      setError(failure?.message || copy.failed);
    } finally {
      setBusy(false);
    }
  }
  const fieldId = `question-${question.id}-answer`;
  const fields = quick ? [] : question.questions.map(fieldOf);
  const answers = quick ? null : cardAnswers(fields, drafts);
  return (
    <article className="assistant-approval-card" data-pending="" aria-label={copy.title}>
      <div className="assistant-approval-head">
        <strong>{copy.title}</strong>
        <small>{copy.waiting}</small>
      </div>
      {quick ? (
        <>
          <p>{first.text}</p>
          {first.options.length > 0 && (
            <div className="assistant-card-actions">
              {first.options.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => send({ [first.id]: [option.label] })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          {first.other && (
            <form
              className="agent-field"
              onSubmit={(event) => {
                event.preventDefault();
                if (text.trim()) send({ [first.id]: [text] });
              }}
            >
              <label htmlFor={fieldId}>{copy.answer}</label>
              <textarea
                id={fieldId}
                rows={2}
                maxLength={16384}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <div className="assistant-card-actions">
                <button
                  type="submit"
                  className="button primary"
                  disabled={busy || !text.trim()}
                >
                  {copy.send}
                </button>
              </div>
            </form>
          )}
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (answers) send(answers);
          }}
        >
          {fields.map((field) => (
            <QuestionFields
              key={field.id}
              question={field}
              value={drafts[field.id]}
              disabled={busy}
              onChange={(draft) => setDrafts((all) => ({ ...all, [field.id]: draft }))}
            />
          ))}
          <div className="assistant-card-actions">
            <button type="submit" className="button primary" disabled={busy || !answers}>
              {copy.send}
            </button>
          </div>
        </form>
      )}
      {question.expiresAt && (
        <p className="assistant-note">
          {copy.expires(formatTimestamp(question.expiresAt))}
        </p>
      )}
      <ErrorMessage error={error} />
    </article>
  );
}
