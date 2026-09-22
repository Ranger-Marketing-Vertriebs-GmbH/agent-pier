import React, { useId, useState } from "react";
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
export function questionNotes(questions, drafts) {
  const notes = {};
  for (const question of questions) {
    const note = drafts[question.id]?.note?.trim();
    if (question.notes && note) notes[question.id] = note;
  }
  return Object.keys(notes).length ? notes : null;
}
export default function QuestionFields({ question, value = {}, onChange, disabled }) {
  const fieldId = useId();
  const [focused, setFocused] = useState(null);
  const [noteOpen, setNoteOpen] = useState(Boolean(value.note));
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
  const previews = question.options.filter((option) => option.preview);
  // Like Claude's native dialog, show the preview of the option in focus;
  // fall back to the latest selection, then to the first preview.
  const shown =
    previews.find((option) => option.id === focused) ||
    previews.find((option) => option.id === value.selected?.at(-1)) ||
    previews[0];
  const choices = question.options.map((option, index) => (
    <label
      key={option.id}
      className="native-choice"
      onPointerEnter={() => option.preview && setFocused(option.id)}
    >
      <input
        type={question.multiple ? "checkbox" : "radio"}
        name={question.id}
        aria-label={option.label}
        aria-describedby={
          option.description ? `${fieldId}-${index}-description` : undefined
        }
        value={option.id}
        checked={(value.selected || []).includes(option.id)}
        onFocus={() => option.preview && setFocused(option.id)}
        onChange={(event) => select(option.id, event.target.checked)}
      />
      <span dir="auto">
        {option.label}
        {option.description && (
          <small id={`${fieldId}-${index}-description`}>{option.description}</small>
        )}
      </span>
    </label>
  ));
  return (
    <fieldset disabled={disabled} className="native-question">
      <legend dir="auto">
        {question.header && <strong>{question.header}: </strong>}
        {question.prompt}
      </legend>
      {shown ? (
        <div className="native-question-layout">
          <div className="native-question-choices">{choices}</div>
          <figure className="native-question-preview">
            <figcaption>{copy.preview(shown.label)}</figcaption>
            {/* Previews are untrusted native text; never render them as HTML. */}
            <pre dir="auto" tabIndex={0} aria-label={copy.preview(shown.label)}>
              {shown.preview}
            </pre>
          </figure>
        </div>
      ) : (
        choices
      )}
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
              dir="auto"
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
      {question.notes && !question.secret && (
        <details
          className="native-question-note"
          open={noteOpen}
          onToggle={(event) => setNoteOpen(event.currentTarget.open)}
        >
          <summary>{copy.note}</summary>
          <textarea
            dir="auto"
            autoComplete="off"
            maxLength={8000}
            aria-label={copy.noteLabel(question.prompt)}
            value={value.note || ""}
            onChange={(event) => onChange({ ...value, note: event.target.value })}
          />
        </details>
      )}
    </fieldset>
  );
}
