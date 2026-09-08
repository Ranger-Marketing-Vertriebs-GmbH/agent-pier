import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/de/pipelines.js";
export default function StageCards({ stages, setStages, profiles, disabled = false }) {
  const patch = (index, change) =>
    setStages(stages.map((stage, i) => (i === index ? { ...stage, ...change } : stage)));
  const move = (index, delta) => {
    const next = [...stages];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    setStages(next);
  };
  return (
    <>
      {stages.map((stage, index) => (
        <section className="pipeline-card pipeline-stage" key={stage.key}>
          <header>
            <strong>{copy.stageNumber(index + 1)}</strong>
            <button
              type="button"
              className="button secondary compact"
              aria-label={`${copy.moveUp} ${index + 1}`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="button secondary compact"
              aria-label={`${copy.moveDown} ${index + 1}`}
              disabled={index === stages.length - 1}
              onClick={() => move(index, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="button secondary compact"
              aria-label={`${copy.removeStage} ${index + 1}`}
              onClick={() =>
                setStages(
                  stages
                    .filter((_, i) => i !== index)
                    .map((s) =>
                      s.loopBackTo === stage.key ? { ...s, loopBackTo: "" } : s,
                    ),
                )
              }
            >
              ×
            </button>
          </header>
          <label>
            {copy.profile}
            <AnchoredSelect
              label={copy.profile}
              required
              value={stage.profileId}
              disabled={disabled}
              onChange={(value) => patch(index, { profileId: value })}
              options={[
                { value: "", label: copy.chooseProfile },
                ...(!profiles.some((p) => p.id === stage.profileId) && stage.profileId
                  ? [{ value: stage.profileId, label: stage.profileId }]
                  : []),
                ...profiles.map((profile) => ({
                  value: profile.id,
                  label: profile.name,
                })),
              ]}
            />
          </label>
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
                  if (field === "createPr" && event.target.checked)
                    setStages(stages.map((s, i) => ({ ...s, createPr: i === index })));
                  else patch(index, { [field]: event.target.checked });
                }}
              />
              {label}
            </label>
          ))}
          {index > 0 && (
            <>
              <label>
                {copy.loopTarget}
                <AnchoredSelect
                  label={copy.loopTarget}
                  value={stage.loopBackTo}
                  disabled={disabled}
                  onChange={(value) => patch(index, { loopBackTo: value })}
                  options={[
                    { value: "", label: copy.noLoop },
                    ...stages.slice(0, index).map((s, i) => ({
                      value: s.key,
                      label: `${i + 1} · ${profiles.find((p) => p.id === s.profileId)?.name || s.profileId}`,
                    })),
                  ]}
                />
              </label>
              {stage.loopBackTo && (
                <label>
                  {copy.loopBudget}
                  <input
                    type="number"
                    min="1"
                    max="5"
                    value={stage.maxIterations}
                    onChange={(event) =>
                      patch(index, { maxIterations: Number(event.target.value) })
                    }
                  />
                </label>
              )}
            </>
          )}
        </section>
      ))}
      <button
        type="button"
        className="button secondary"
        onClick={() =>
          setStages([
            ...stages,
            {
              key: `stage-${crypto.randomUUID()}`,
              profileId: "",
              gate: false,
              verify: false,
              createPr: false,
              loopBackTo: "",
              maxIterations: 2,
            },
          ])
        }
      >
        {copy.addStage}
      </button>
    </>
  );
}
