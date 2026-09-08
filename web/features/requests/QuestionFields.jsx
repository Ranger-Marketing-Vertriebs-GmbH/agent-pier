import React, { useId } from "react";
import { requestCopy as copy } from "../../lib/i18n/messages/requests.js";
export function questionAnswers(questions, drafts) {
  const answers = {};
  for (const question of questions) {
    const draft = drafts[question.id] || {},
      values = [...(draft.selected || [])];
    if (draft.other || !question.options.length) {
      if (!draft.text?.trim()) return null;
      values.push(draft.text);
    }
    if (!values.length) return null;
    answers[question.id] = values;
  }
  return answers;
}
export default function QuestionFields({ question, value = {}, onChange, disabled }) {
  const fieldId = useId();
  const other = value.other || !question.options.length;
  const TextField = question.secret ? "input" : "textarea";
  const select = (id, checked) =>
    onChange({
      ...value,
      other: question.multiple ? value.other : false,
      selected: question.multiple
        ? checked
          ? [...(value.selected || []), id]
          : (value.selected || []).filter((item) => item !== id)
        : [id],
    });
  return (
    <fieldset disabled={disabled} className="native-question">
      <legend>
        {question.header && <strong>{question.header}: </strong>}
        {question.prompt}
      </legend>
      {question.options.map((option, index) => (
        <label key={option.id} className="native-choice">
          <input
            type={question.multiple ? "checkbox" : "radio"}
            name={question.id}
            aria-label={option.label}
            aria-describedby={
              option.description ? `${fieldId}-${index}-description` : undefined
            }
            value={option.id}
            checked={(value.selected || []).includes(option.id)}
            onChange={(event) => select(option.id, event.target.checked)}
          />
          <span>
            {option.label}
            {option.description && (
              <small id={`${fieldId}-${index}-description`}>{option.description}</small>
            )}
          </span>
        </label>
      ))}
      {question.allowOther && (
        <>
          <label className="native-choice">
            <input
              type={question.multiple ? "checkbox" : "radio"}
              name={question.id}
              checked={other}
              onChange={(event) =>
                onChange({
                  ...value,
                  other: event.target.checked,
                  selected: question.multiple ? value.selected : [],
                })
              }
            />
            {copy.other}
          </label>
          {other && (
            <TextField
              type={question.secret ? "password" : undefined}
              autoComplete="off"
              aria-label={copy.otherLabel(question.prompt)}
              value={value.text || ""}
              onChange={(event) =>
                onChange({ ...value, text: event.target.value, other: true })
              }
            />
          )}
        </>
      )}
    </fieldset>
  );
}
