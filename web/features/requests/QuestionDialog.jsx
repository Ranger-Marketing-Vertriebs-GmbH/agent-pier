import React, { useEffect, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { requestCopy as copy } from "../../lib/i18n/messages/requests.js";
import QuestionFields, { questionAnswers, questionNotes } from "./QuestionFields.jsx";

export default function QuestionDialog({
  questions,
  busy,
  answer,
  declinable = false,
  onInteract = () => {},
}) {
  const [drafts, setDrafts] = useState({});
  const [step, setStep] = useState(0);
  const [validation, setValidation] = useState("");
  // Declining cannot be undone, so it takes a second, deliberate click.
  const [confirmDecline, setConfirmDecline] = useState(false);
  const heading = useRef(null);
  useEffect(() => {
    if (!confirmDecline) return;
    const timer = setTimeout(() => setConfirmDecline(false), 5000);
    return () => clearTimeout(timer);
  }, [confirmDecline]);
  const question = questions[step];
  const last = step === questions.length - 1;
  const navigate = (index) => {
    setConfirmDecline(false);
    setStep(index);
    setValidation("");
    heading.current?.focus();
    heading.current?.scrollIntoView({ block: "nearest" });
  };
  if (!question) return null;
  return (
    <form
      className="native-question-dialog"
      onSubmit={(event) => {
        event.preventDefault();
        if (!questionAnswers([question], drafts)) {
          setValidation(copy.required);
          return;
        }
        if (!last) {
          navigate(step + 1);
          return;
        }
        const answers = questionAnswers(questions, drafts);
        if (!answers) {
          navigate(questions.findIndex((item) => !questionAnswers([item], drafts)));
          setValidation(copy.required);
          return;
        }
        setValidation("");
        const notes = questionNotes(questions, drafts);
        answer({ answers, ...(notes ? { notes } : {}) });
      }}
      onPointerDown={onInteract}
      onKeyDown={onInteract}
      onFocus={onInteract}
    >
      <p
        ref={heading}
        tabIndex={-1}
        aria-live="polite"
        className="native-question-progress"
      >
        {copy.progress(step + 1, questions.length)}
      </p>
      <div
        className="native-question-body"
        key={question.id}
        onFocusCapture={(event) => {
          if (
            event.target.matches('textarea, input[type="text"], input[type="password"]')
          )
            event.target.scrollIntoView({ block: "nearest" });
        }}
      >
        <QuestionFields
          key={question.id}
          question={question}
          value={drafts[question.id]}
          disabled={busy}
          onChange={(value) => {
            setConfirmDecline(false);
            setDrafts((current) => ({ ...current, [question.id]: value }));
          }}
        />
        <ErrorMessage error={validation} />
      </div>
      <div className="native-request-actions native-question-navigation">
        {step > 0 && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => navigate(step - 1)}
          >
            {copy.previous}
          </button>
        )}
        <button className="button primary" disabled={busy}>
          {last ? copy.answer : copy.next}
        </button>
        {declinable && (
          <button
            type="button"
            className={`button ${confirmDecline ? "danger" : "secondary"} native-question-decline`}
            disabled={busy}
            onClick={() => {
              setValidation("");
              if (!confirmDecline) {
                setConfirmDecline(true);
                return;
              }
              setConfirmDecline(false);
              const notes = questionNotes(questions, drafts);
              answer({ decline: true, ...(notes ? { notes } : {}) });
            }}
          >
            {confirmDecline ? copy.declineConfirm : copy.decline}
          </button>
        )}
      </div>
    </form>
  );
}
