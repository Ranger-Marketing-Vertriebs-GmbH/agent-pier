import React, { useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { requestCopy as copy } from "../../lib/i18n/messages/requests.js";
import QuestionFields, { questionAnswers } from "./QuestionFields.jsx";

export default function QuestionDialog({ questions, busy, answer }) {
  const [drafts, setDrafts] = useState({});
  const [step, setStep] = useState(0);
  const [validation, setValidation] = useState("");
  const heading = useRef(null);
  const question = questions[step];
  const last = step === questions.length - 1;
  const navigate = (index) => {
    setStep(index);
    setValidation("");
    heading.current?.focus();
    heading.current?.scrollIntoView({ block: "nearest" });
  };
  if (!question) return null;
  return (
    <form
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
        answer({ answers });
      }}
    >
      <p
        ref={heading}
        tabIndex={-1}
        aria-live="polite"
        className="native-question-progress"
      >
        {copy.progress(step + 1, questions.length)}
      </p>
      <QuestionFields
        key={question.id}
        question={question}
        value={drafts[question.id]}
        disabled={busy}
        onChange={(value) =>
          setDrafts((current) => ({ ...current, [question.id]: value }))
        }
      />
      <ErrorMessage error={validation} />
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
      </div>
    </form>
  );
}
