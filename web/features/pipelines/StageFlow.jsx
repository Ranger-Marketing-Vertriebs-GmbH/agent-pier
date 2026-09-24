import React from "react";
import Icon from "../../components/Icon.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";

// A stage names its profile; a saved id without a known profile stays readable.
export function stageProfileName(stage, profiles) {
  return profiles.find((p) => p.id === stage.profileId)?.name || stage.profileId;
}

function stageFlags(stage, stages) {
  const loop = stages.findIndex((s) => s.key === stage.loopBackTo);
  return [
    stage.gate && copy.stageFlags.gate,
    stage.verify && copy.stageFlags.verify,
    stage.createPr && copy.stageFlags.pr,
    stage.loopBackTo && copy.loopTo(loop + 1),
  ].filter(Boolean);
}

export default function StageFlow({ stages, profiles, selected, onSelect, onAdd }) {
  const loops = stages
    .map((stage, index) =>
      stage.loopBackTo
        ? copy.loopCaption(
            stageProfileName(stage, profiles) || copy.stageNumber(index + 1),
            stages.findIndex((s) => s.key === stage.loopBackTo) + 1,
            stage.maxIterations,
          )
        : "",
    )
    .filter(Boolean);
  return (
    <div className="stage-flow-section">
      <span className="stage-caps" aria-hidden="true">
        {copy.stages}
      </span>
      <ol className="stage-flow" aria-label={copy.stages}>
        {stages.map((stage, index) => {
          const name = stageProfileName(stage, profiles);
          return (
            <li key={stage.key}>
              {index > 0 && (
                <span className="stage-flow-arrow" aria-hidden="true">
                  →
                </span>
              )}
              <button
                type="button"
                className={`stage-tile${index === selected ? " selected" : ""}`}
                aria-pressed={index === selected}
                onClick={() => onSelect(index)}
              >
                <span className="stage-tile-number">{copy.stageNumber(index + 1)}</span>
                <strong className={name ? "" : "placeholder"}>
                  {name || copy.chooseProfile}
                </strong>
                <small>
                  {stageFlags(stage, stages).join(" · ") || copy.noStageFlags}
                </small>
              </button>
            </li>
          );
        })}
        <li>
          <button type="button" className="stage-add" onClick={onAdd}>
            <Icon name="plus" size={14} />
            {copy.addStage}
          </button>
        </li>
      </ol>
      {loops.length > 0 && <p className="stage-loop-caption">↺ {loops.join(" · ")}</p>}
    </div>
  );
}
