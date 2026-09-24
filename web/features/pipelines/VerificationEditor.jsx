import React, { useEffect, useId, useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";

// One step per row: # · Name · Befehl · Zeitlimit (s) · blocking · order and removal.
function StepRow({ step, index, count, patch, move, remove }) {
  const number = index + 1;
  return (
    <li className="verification-step">
      <span className="verification-step-number" aria-hidden="true">
        {number}
      </span>
      <input
        className="verification-step-name"
        aria-label={copy.stepName(number)}
        required
        value={step.name}
        onChange={(event) => patch({ name: event.target.value })}
      />
      <input
        className="verification-step-command"
        aria-label={copy.stepCommand(number)}
        required
        value={step.command}
        onChange={(event) => patch({ command: event.target.value })}
      />
      <input
        className="verification-step-timeout"
        aria-label={copy.stepTimeout(number)}
        type="number"
        min="1"
        required
        value={step.timeoutMs / 1000}
        onChange={(event) => patch({ timeoutMs: Number(event.target.value) * 1000 })}
      />
      <label className="pipeline-check verification-step-blocking">
        <input
          type="checkbox"
          checked={step.blocking}
          onChange={(event) => patch({ blocking: event.target.checked })}
        />
        {copy.blocking}
      </label>
      <div className="verification-step-actions">
        <button
          type="button"
          className="button secondary"
          aria-label={`${copy.moveUp} ${number}`}
          disabled={index === 0}
          onClick={() => move(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="button secondary"
          aria-label={`${copy.moveDown} ${number}`}
          disabled={index === count - 1}
          onClick={() => move(1)}
        >
          ↓
        </button>
        <button
          type="button"
          className="button secondary"
          aria-label={`${copy.removeStep} ${number}`}
          onClick={remove}
        >
          {commonCopy.remove}
        </button>
      </div>
    </li>
  );
}

export default function VerificationEditor({
  projectId,
  name,
  initial,
  saved,
  onDirtyChange,
}) {
  const [steps, setSteps] = useState(initial);
  const dirty = JSON.stringify(steps) !== JSON.stringify(initial);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const headingId = useId();
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
      className="pipeline-form verification-card"
      aria-labelledby={headingId}
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
      <fieldset disabled={action.busy}>
        <header className="verification-head">
          <div>
            <h2 id={headingId}>{name}</h2>
            <p>{copy.verifyHelp}</p>
          </div>
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
            <Icon name="plus" size={14} />
            {copy.newStep}
          </button>
        </header>
        {!steps.length && <p className="verification-empty">{copy.noSteps}</p>}
        {steps.length > 0 && (
          <div className="verification-columns" aria-hidden="true">
            <span />
            <span>{copy.name}</span>
            <span>{copy.stepColumns.command}</span>
            <span>{copy.stepColumns.timeout}</span>
            <span>{copy.stepColumns.failure}</span>
            <span />
          </div>
        )}
        <ol className="verification-steps">
          {steps.map((step, index) => (
            <StepRow
              key={index}
              step={step}
              index={index}
              count={steps.length}
              patch={(change) => patch(index, change)}
              move={(delta) => move(index, delta)}
              remove={() => setSteps(steps.filter((_, i) => i !== index))}
            />
          ))}
        </ol>
      </fieldset>
      <ErrorMessage error={action.error} />
      <div className="profile-footer">
        <button className="button primary" disabled={action.busy}>
          {commonCopy.save}
        </button>
      </div>
    </form>
  );
}
