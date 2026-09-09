import React, { useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
export default function VerificationEditor({ projectId, initial, saved }) {
  const [steps, setSteps] = useState(initial);
  const action = useAsyncAction();
  const patch = (index, change) =>
    setSteps(steps.map((step, i) => (i === index ? { ...step, ...change } : step)));
  const move = (index, delta) => {
    const next = [...steps];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    setSteps(next);
  };
  return (
    <form
      className="pipeline-form"
      onSubmit={(event) => {
        event.preventDefault();
        action.run(async () => {
          await api(`/pipeline-verification/${encodeURIComponent(projectId)}`, "PUT", {
            steps,
          });
          saved();
        });
      }}
    >
      <p className="field-description">{copy.verifyHelp}</p>
      <fieldset disabled={action.busy}>
        {!steps.length && <p>{copy.noSteps}</p>}
        {steps.map((step, index) => (
          <section className="pipeline-card pipeline-verification-step" key={index}>
            <label>
              {copy.stepName(index + 1)}
              <input
                required
                value={step.name}
                onChange={(event) => patch(index, { name: event.target.value })}
              />
            </label>
            <label>
              {copy.stepCommand(index + 1)}
              <input
                required
                value={step.command}
                onChange={(event) => patch(index, { command: event.target.value })}
              />
            </label>
            <label>
              {copy.stepTimeout(index + 1)}
              <input
                type="number"
                min="1"
                required
                value={step.timeoutMs / 1000}
                onChange={(event) =>
                  patch(index, { timeoutMs: Number(event.target.value) * 1000 })
                }
              />
            </label>
            <label className="pipeline-check">
              <input
                type="checkbox"
                checked={step.blocking}
                onChange={(event) => patch(index, { blocking: event.target.checked })}
              />
              {copy.blocking}
            </label>
            <div className="pipeline-actions">
              <button
                type="button"
                className="button secondary"
                aria-label={`${copy.moveUp} ${index + 1}`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="button secondary"
                aria-label={`${copy.moveDown} ${index + 1}`}
                disabled={index === steps.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="button secondary"
                aria-label={`${copy.removeStep} ${index + 1}`}
                onClick={() => setSteps(steps.filter((_, i) => i !== index))}
              >
                {commonCopy.remove}
              </button>
            </div>
          </section>
        ))}
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            setSteps([
              ...steps,
              { name: "", command: "", timeoutMs: 600000, blocking: true },
            ])
          }
        >
          {copy.newStep}
        </button>
      </fieldset>
      <ErrorMessage error={action.error} />
      <button className="button primary" disabled={action.busy}>
        {commonCopy.save}
      </button>
    </form>
  );
}
