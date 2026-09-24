import React, { useId, useState } from "react";
import Segment from "../../components/Segment.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { stageProfileName } from "./StageFlow.jsx";

const minRounds = 1,
  maxRounds = 5;

function RoundsStepper({ value, onChange, disabled }) {
  const id = useId();
  const clamp = (number) => Math.min(maxRounds, Math.max(minRounds, number));
  const current = Number.isFinite(value) ? clamp(value) : minRounds;
  // An emptied field stays empty while typing and returns to the last value on blur.
  const [typing, setTyping] = useState(null);
  return (
    <div className="stage-field">
      <label htmlFor={id}>{copy.loopBudget}</label>
      <div className="stage-stepper">
        <button
          type="button"
          aria-label={copy.decreaseRounds}
          disabled={disabled || current <= minRounds}
          onClick={() => onChange(clamp(current - 1))}
        >
          −
        </button>
        <input
          id={id}
          type="number"
          min={minRounds}
          max={maxRounds}
          value={typing ?? (Number.isFinite(value) ? value : minRounds)}
          onChange={(event) => {
            const text = event.target.value;
            const number = Number(text);
            if (text === "" || !Number.isFinite(number)) return setTyping(text);
            setTyping(null);
            onChange(clamp(Math.round(number)));
          }}
          onBlur={() => setTyping(null)}
        />
        <button
          type="button"
          aria-label={copy.increaseRounds}
          disabled={disabled || current >= maxRounds}
          onClick={() => onChange(clamp(current + 1))}
        >
          +
        </button>
      </div>
    </div>
  );
}

// Edits the one stage chosen in the flow. The profile choice lists only profiles
// eligible for stages, plus a saved profile id that no longer is.
export default function StageEditor({
  stages,
  index,
  profiles,
  setStages,
  onMove,
  onRemove,
  disabled = false,
}) {
  const stage = stages[index];
  const number = index + 1;
  const headingId = useId();
  const patch = (change) =>
    setStages(stages.map((s, i) => (i === index ? { ...s, ...change } : s)));
  const profileOptions = [
    ...(stage.profileId && !profiles.some((p) => p.id === stage.profileId)
      ? [{ value: stage.profileId, label: stage.profileId }]
      : []),
    ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
  ];
  return (
    <section className="stage-editor" aria-labelledby={headingId}>
      <header>
        <h3 id={headingId}>{copy.editStage(number)}</h3>
        <div className="stage-editor-actions">
          <button
            type="button"
            className="button secondary compact"
            aria-label={`${copy.moveForward} ${number}`}
            disabled={index === 0}
            onClick={() => onMove(index, -1)}
          >
            {copy.moveForward}
          </button>
          <button
            type="button"
            className="button secondary compact"
            aria-label={`${copy.moveBackward} ${number}`}
            disabled={index === stages.length - 1}
            onClick={() => onMove(index, 1)}
          >
            {copy.moveBackward}
          </button>
          <button
            type="button"
            className="button secondary compact"
            aria-label={`${copy.removeStage} ${number}`}
            onClick={() => onRemove(index)}
          >
            {copy.removeStage}
          </button>
        </div>
      </header>
      <div className="stage-field">
        <span aria-hidden="true">{copy.profile}</span>
        <Segment
          label={copy.profile}
          className="stage-pills"
          required
          disabled={disabled}
          value={stage.profileId}
          options={profileOptions}
          onChange={(value) => patch({ profileId: value })}
        />
        <small>{copy.profileEligibility}</small>
      </div>
      <div className="stage-checks">
        {[
          ["gate", copy.humanGate],
          ["verify", copy.verifyStage],
          ["createPr", copy.createPr],
        ].map(([field, label]) => (
          <label key={field} className="pipeline-check">
            <input
              type="checkbox"
              checked={stage[field]}
              onChange={(event) => {
                // Only one stage may open the pull request.
                if (field === "createPr" && event.target.checked)
                  setStages(stages.map((s, i) => ({ ...s, createPr: i === index })));
                else patch({ [field]: event.target.checked });
              }}
            />
            {label}
          </label>
        ))}
      </div>
      {index > 0 && (
        <div className="stage-loop">
          <div className="stage-field">
            <span aria-hidden="true">{copy.loopTarget}</span>
            <Segment
              label={copy.loopTarget}
              className="stage-pills"
              disabled={disabled}
              value={stage.loopBackTo}
              options={[
                { value: "", label: copy.noLoop },
                ...stages.slice(0, index).map((s, i) => ({
                  value: s.key,
                  label: `${i + 1} · ${stageProfileName(s, profiles) || copy.chooseProfile}`,
                })),
              ]}
              onChange={(value) => patch({ loopBackTo: value })}
            />
          </div>
          {stage.loopBackTo && (
            <RoundsStepper
              value={stage.maxIterations}
              disabled={disabled}
              onChange={(value) => patch({ maxIterations: value })}
            />
          )}
        </div>
      )}
    </section>
  );
}
