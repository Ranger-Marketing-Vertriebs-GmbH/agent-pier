import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { assistantWorkflowCopy } from "../../lib/i18n/messages/assistant-workflows.js";
import { assistantApi } from "./assistant-api.js";

/**
 * A question the agent waits on in this chat (server agent-questions.js): its
 * choices as buttons and a field for an answer of the owner's own. The answer goes
 * back to the agent's turn; the card leaves once the feed no longer lists it.
 */
export default function QuestionCard({ conversationId, question }) {
  const copy = assistantWorkflowCopy.question;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function send(answer) {
    setBusy(true);
    setError(null);
    try {
      await assistantApi.answerQuestion(conversationId, question.id, answer);
      setText("");
    } catch (failure) {
      // The server names why (the agent no longer waits), translated.
      setError(failure?.message || copy.failed);
    } finally {
      setBusy(false);
    }
  }
  const fieldId = `question-${question.id}-answer`;
  return (
    <article className="assistant-approval-card" data-pending="" aria-label={copy.title}>
      <div className="assistant-approval-head">
        <strong>{copy.title}</strong>
        <small>{copy.waiting}</small>
      </div>
      <p>{question.question}</p>
      {question.choices.length > 0 && (
        <div className="assistant-card-actions">
          {question.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => send(choice)}
            >
              {choice}
            </button>
          ))}
        </div>
      )}
      <form
        className="agent-field"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) send(text);
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
      {question.expiresAt && (
        <p className="assistant-note">
          {copy.expires(formatTimestamp(question.expiresAt))}
        </p>
      )}
      <ErrorMessage error={error} />
    </article>
  );
}
